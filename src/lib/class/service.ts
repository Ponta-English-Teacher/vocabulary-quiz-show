import { randomBytes } from "node:crypto";
import { coerceWord } from "@/lib/studio/validation";
import type { VocabWord } from "@/data/vocab";
import type { ClassView } from "./types";
import {
  applyAction, buildView, claimSeat, cleanName, cloneRoom, fail, hashToken, newRoom, normalizeGroup, other, parseAction,
  seatFor, type ClassActivity, type Fail, type Room,
} from "./engine";
import { KvConfigError, KvError, kvFromEnv, versionOf, type KV } from "./kv";

/**
 * The classroom service: all state lives in shared storage (Upstash Redis on Vercel), never in this process.
 * Every request is self-contained, so it works no matter which serverless instance handles it.
 *
 *  - reading a room is side-effect free; "I'm still here" is a separate short-lived presence key per seat
 *  - changing a room = read → apply the pure rules to a copy → atomic compare-and-set on its version;
 *    if another request got there first the change is re-applied to the fresh state (bounded retries)
 */

export const PRESENCE_SECONDS = 15;
const ROOM_TTL = 6 * 60 * 60;
const ACTIVITY_TTL = 24 * 60 * 60;
const MAX_ATTEMPTS = 6;

export type PartnerState = boolean | null; // true/false = partner connected or not, null = no partner yet

export type JoinResult = { ok: true; token: string; seat: 0 | 1; rejoined: boolean; view: ClassView } | Fail;
export type ViewResult = { ok: true; unchanged: false; view: ClassView } | { ok: true; unchanged: true; version: number } | Fail;
export type ActResult = { ok: true; applied: boolean; view: ClassView | null } | Fail;

const roomKey = (activityId: string, group: string) => `vqs:room:${activityId}:${group}`;
const actKey = (id: string) => `vqs:act:${id}`;
const presKey = (activityId: string, group: string, seat: 0 | 1) => `vqs:pres:${activityId}:${group}:${seat}`;

const serialize = (r: Room) => `${r.version}|${JSON.stringify(r)}`;
function parseRoom(stored: string | null): { room: Room; version: number } | null {
  if (!stored) return null;
  try {
    const room = JSON.parse(stored.slice(stored.indexOf("|") + 1)) as Room;
    return { room, version: versionOf(stored) };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_ACTIVITY = "This class link isn't valid or has expired. Ask your teacher for a new link.";

export class ClassService {
  private resolved: KV | null = null;
  /** Storage is resolved lazily so a missing configuration surfaces as a friendly 'unavailable' error, not a crash. */
  constructor(private source: KV | (() => KV), private now: () => number = Date.now) {}
  private get kv(): KV {
    return (this.resolved ??= typeof this.source === "function" ? this.source() : this.source);
  }

  /** Turn storage failures into a friendly, retryable error (never leaks details). */
  private async guard<T>(fn: () => Promise<T>): Promise<T | Fail> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof KvConfigError) return fail("unavailable", "The classroom service isn't set up yet. Please tell your teacher.");
      if (e instanceof KvError) return fail("unavailable", "The classroom service is temporarily unavailable. Please try again.");
      throw e;
    }
  }

  // ---- activities ------------------------------------------------------------------

  async createActivity(input: { title: unknown; words: unknown }): Promise<{ ok: true; activity: ClassActivity } | Fail> {
    if (typeof input.title !== "string" || !Array.isArray(input.words) || input.words.length < 1 || input.words.length > 50) {
      return fail("bad_request", "An activity needs a title and 1–50 words.");
    }
    const words: VocabWord[] = [];
    const ids = new Set<string>();
    for (const raw of input.words) {
      const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : undefined;
      const c = coerceWord(raw, { id });
      if (!("word" in c) || ids.has(c.word.id)) return fail("bad_request", "One of the words is invalid.");
      ids.add(c.word.id);
      words.push(c.word);
    }
    const activity: ClassActivity = {
      id: randomBytes(5).toString("hex"), // 10 hex chars
      title: input.title.trim().slice(0, 100) || "Class activity",
      words,
      createdAt: this.now(),
    };
    const r = await this.guard(async () => {
      await this.kv.set(actKey(activity.id), JSON.stringify(activity), ACTIVITY_TTL);
      return true as const;
    });
    return r === true ? { ok: true, activity } : r;
  }

  private async loadActivity(id: string): Promise<ClassActivity | null> {
    const raw = await this.kv.get(actKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ClassActivity;
    } catch {
      return null;
    }
  }

  async getActivityInfo(id: string): Promise<{ title: string; wordCount: number } | null | Fail> {
    return this.guard(async () => {
      const a = await this.loadActivity(id);
      return a ? { title: a.title, wordCount: a.words.length } : null;
    });
  }

  // ---- presence ----------------------------------------------------------------------

  /** Mark this seat present and learn whether the partner is (one round trip). */
  private async touch(room: Room, seat: 0 | 1): Promise<PartnerState> {
    const partner = other(seat);
    const [, exists] = await this.kv.pipeline([
      { op: "set", key: presKey(room.activityId, room.group, seat), value: "1", ttl: PRESENCE_SECONDS },
      { op: "exists", key: presKey(room.activityId, room.group, partner) },
    ]);
    return room.seats[partner] ? exists === 1 : null;
  }

  // ---- joining -----------------------------------------------------------------------

  async join(input: { activityId: string; group: unknown; name: unknown; token?: unknown }): Promise<JoinResult> {
    return (await this.guard(async (): Promise<JoinResult> => {
      const group = normalizeGroup(input.group);
      if (!group) {
        // Still tell an unknown activity apart from a bad group number.
        return (await this.loadActivity(input.activityId)) ? fail("bad_group", "Enter your group number (1–999).") : fail("no_activity", NO_ACTIVITY);
      }
      const key = roomKey(input.activityId, group);
      let activity: ClassActivity | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = parseRoom(await this.kv.get(key));

        // Returning player: a valid token reclaims its own seat, nothing else.
        if (cur && typeof input.token === "string") {
          const seat = seatFor(cur.room, input.token);
          if (seat !== null) {
            const partner = await this.touch(cur.room, seat);
            return { ok: true, token: input.token, seat, rejoined: true, view: buildView(cur.room, seat, partner) };
          }
        }

        activity ??= await this.loadActivity(input.activityId);
        if (!activity) return fail("no_activity", NO_ACTIVITY);
        const name = cleanName(input.name);
        if (!name) return fail("bad_name", "Enter your name.");

        const room = cur ? cloneRoom(cur.room) : newRoom(activity, group, this.now());
        const token = randomBytes(16).toString("hex");
        const claimed = claimSeat(room, name, hashToken(token), this.now());
        if ("ok" in claimed) return claimed; // full
        if (await this.kv.cas(key, cur?.version ?? 0, serialize(room), ROOM_TTL)) {
          const partner = await this.touch(room, claimed.seat);
          return { ok: true, token, seat: claimed.seat, rejoined: false, view: buildView(room, claimed.seat, partner) };
        }
        await sleep(10 + Math.random() * 30); // lost a race with another request: re-read and try again
      }
      return fail("busy", "The classroom is busy. Please try again.");
    })) as JoinResult;
  }

  // ---- reading state -----------------------------------------------------------------

  /**
   * `since` = the version the phone already has; `partnerWas` = what it last showed for the partner's connection.
   * Unchanged only if BOTH match, so a partner dropping or returning is noticed even when the game didn't change.
   */
  async getView(input: { activityId: string; group: unknown; token: unknown; since?: number; partnerWas?: PartnerState }): Promise<ViewResult> {
    return (await this.guard(async (): Promise<ViewResult> => {
      const group = normalizeGroup(input.group);
      if (!group) return fail("bad_group", "Invalid group.");
      const cur = parseRoom(await this.kv.get(roomKey(input.activityId, group)));
      if (!cur) {
        return (await this.loadActivity(input.activityId)) ? fail("unauthorized", "Please join the group again.") : fail("no_activity", NO_ACTIVITY);
      }
      const seat = typeof input.token === "string" ? seatFor(cur.room, input.token) : null;
      if (seat === null) return fail("unauthorized", "Please join the group again.");
      const partner = await this.touch(cur.room, seat);
      if (input.since !== undefined && input.since === cur.room.version && (input.partnerWas === undefined || input.partnerWas === partner)) {
        return { ok: true, unchanged: true, version: cur.room.version };
      }
      return { ok: true, unchanged: false, view: buildView(cur.room, seat, partner) };
    })) as ViewResult;
  }

  // ---- acting -----------------------------------------------------------------------

  async act(input: { activityId: string; group: unknown; token: unknown; opId?: unknown; action: unknown }): Promise<ActResult> {
    return (await this.guard(async (): Promise<ActResult> => {
      const group = normalizeGroup(input.group);
      if (!group) return fail("bad_group", "Invalid group.");
      const key = roomKey(input.activityId, group);
      let words: VocabWord[] | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = parseRoom(await this.kv.get(key));
        if (!cur) {
          return (await this.loadActivity(input.activityId)) ? fail("unauthorized", "Please join the group again.") : fail("no_activity", NO_ACTIVITY);
        }
        const seat = typeof input.token === "string" ? seatFor(cur.room, input.token) : null;
        if (seat === null) return fail("unauthorized", "Please join the group again.");
        const action = parseAction(input.action);
        if (!action) return fail("bad_action", "Unknown action.");

        if (action.type === "CONFIRM_ROLES" && !words) words = (await this.loadActivity(input.activityId))?.words ?? null;

        const room = cloneRoom(cur.room);
        const out = applyAction(room, words, seat, action, input.opId, this.now());
        if ("error" in out) return out.error;
        if (!out.applied) {
          const partner = await this.touch(cur.room, seat);
          return { ok: true, applied: false, view: buildView(cur.room, seat, partner) };
        }
        if (await this.kv.cas(key, cur.version, serialize(room), ROOM_TTL)) {
          if (out.left) return { ok: true, applied: true, view: null };
          const partner = await this.touch(room, seat);
          return { ok: true, applied: true, view: buildView(room, seat, partner) };
        }
        await sleep(10 + Math.random() * 30); // another request changed the room first: re-apply to the fresh state
      }
      return fail("busy", "The classroom is busy. Please try again.");
    })) as ActResult;
  }
}

// ---- one service per server process (storage itself is shared) ------------------------------------------

const G = globalThis as unknown as { __vqsClassService?: ClassService };
export function getClassService(): ClassService {
  return (G.__vqsClassService ??= new ClassService(() => kvFromEnv()));
}

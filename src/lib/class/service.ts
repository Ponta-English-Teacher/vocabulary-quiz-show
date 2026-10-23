import { randomBytes } from "node:crypto";
import { coerceWord } from "@/lib/studio/validation";
import type { Illustration, VocabWord } from "@/data/vocab";
import { generateIllustration, IllustrateError } from "@/lib/studio/illustration";
import type { ClassView } from "./types";
import {
  applyAction, buildView, claimSeat, cleanName, cloneRoom, fail, hashToken, markIllustration, newRoom, normalizeGroup, other, parseAction,
  seatFor, type ClassActivity, type Fail, type Room,
} from "./engine";
import { toStudyWord } from "@/lib/study/service";
import type { StudyWord } from "@/lib/study/types";
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
const imgKey = (activityId: string, wordId: string) => `vqs:img:${activityId}:${wordId}`;
/** All pictures of one hosted activity, in total (each one is also capped by LIMITS.illustrationSrc). */
const MAX_PICTURE_CHARS = 4_000_000;
/** One paid image at a time per (activity, word): whoever holds this key draws; everyone else waits for the cached result. */
const lockKey = (activityId: string, wordId: string) => `vqs:imglock:${activityId}:${wordId}`;
/**
 * Cost guard. A success is cached (so a word is drawn once per activity), but FAILED drawings (timeouts, refusals) leave
 * nothing cached and may still be billed, so attempts are capped: per word, and per hosted activity overall.
 */
export const MAX_DRAWS_PER_WORD = 3;
export const MAX_DRAWS_PER_ACTIVITY = 40;
const wordTriesKey = (activityId: string, wordId: string) => `vqs:imgtries:${activityId}:${wordId}`;
const activityTriesKey = (activityId: string) => `vqs:imgtries:${activityId}`;
const LOCK_TTL = 150; // seconds; longer than the image call can take, so a crashed request can't block a word for long
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

/** What a student is told when drawing fails: plain, never upstream details or hints about server settings. */
function pictureFailureText(e: unknown): string {
  const code = e instanceof IllustrateError ? e.code : "";
  if (code === "timeout") return "The picture took too long to draw.";
  if (code === "refused") return "The AI wouldn't draw a picture for this word.";
  if (code === "no_ai") return "Illustrations aren't available on this server.";
  return "The picture couldn't be made right now.";
}

/** Draws ONE picture for one word (a paid call). Injected so tests use a fake; production uses the OpenAI image API. */
export type Drawer = (word: VocabWord) => Promise<Illustration>;

export interface ClassServiceOptions {
  drawer?: Drawer;
  /** How long a request waits for another request's picture of the same word before giving up (ms). */
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ClassService {
  private resolved: KV | null = null;
  /** Storage is resolved lazily so a missing configuration surfaces as a friendly 'unavailable' error, not a crash. */
  constructor(private source: KV | (() => KV), private now: () => number = Date.now, private opts: ClassServiceOptions = {}) {}
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
    // Pictures live in their own keys, so the activity (read on every join) stays small and can never leak one.
    const pictures = words.flatMap((w) => (w.illustration?.src ? [{ id: w.id, src: w.illustration.src }] : []));
    if (pictures.reduce((n, p) => n + p.src.length, 0) > MAX_PICTURE_CHARS) return fail("bad_request", "The illustrations are too large to host together.");
    const activity: ClassActivity = {
      id: randomBytes(5).toString("hex"), // 10 hex chars
      title: input.title.trim().slice(0, 100) || "Class activity",
      words: words.map((w) => (w.illustration?.src ? { ...w, illustration: { src: "", ...(w.illustration.alt ? { alt: w.illustration.alt } : {}) } } : w)),
      createdAt: this.now(),
    };
    const r = await this.guard(async () => {
      for (const p of pictures) await this.kv.set(imgKey(activity.id, p.id), p.src, ACTIVITY_TTL);
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

  /**
   * Study access: the vocabulary of THIS class activity, as study fields only (see toStudyWord) — no teacher publication step,
   * the class link already identifies the list. A player who has joined and whose game is under way is refused until the
   * game has ended, so the full list is not offered during guessing rounds. Before joining, in the lobby and after the
   * final result it is open. (Someone who has not joined cannot be told apart from anyone else, so this guard protects
   * the app's own screens; it cannot stop a determined student opening the link in a second browser.)
   */
  async getStudy(input: { activityId: string; group?: unknown; token?: unknown }): Promise<{ ok: true; title: string; words: StudyWord[] } | Fail> {
    return (await this.guard(async () => {
      const activity = await this.loadActivity(input.activityId);
      if (!activity) return fail("no_activity", NO_ACTIVITY);
      const group = normalizeGroup(input.group);
      if (group && typeof input.token === "string" && input.token) {
        const cur = parseRoom(await this.kv.get(roomKey(input.activityId, group)));
        if (cur && seatFor(cur.room, input.token) !== null && cur.room.game && cur.room.game.phase !== "final") {
          return fail("forbidden", "Study Vocabulary opens again when your game ends.");
        }
      }
      return { ok: true as const, title: activity.title, words: activity.words.map(toStudyWord) };
    })) as { ok: true; title: string; words: StudyWord[] } | Fail;
  }

  /**
   * The Giver's private picture — only after the Giver asked for it (`illustrationUsed`), only to the Giver, only for the
   * word in play, and only while the round runs. Everyone else, and every other moment, gets no picture at all:
   * redactForRole already removed any picture or marker, so the Taker's view can never reach this branch.
   * A missing/expired image simply means "no picture"; the round is fully playable without it.
   */
  private async withPicture(room: Room, view: ClassView): Promise<ClassView> {
    const g = view.game;
    if (view.role !== "giver" || !g || g.phase !== "round" || !g.currentWordId || !g.illustrationUsed) return view;
    const wordId = g.currentWordId;
    const src = await this.kv.get(imgKey(room.activityId, wordId));
    if (!src) return view;
    const illustration: Illustration = { src, alt: "Picture of the word (for you only)" };
    return { ...view, game: { ...g, words: g.words.map((x) => (x.id === wordId ? { ...x, illustration } : x)) } };
  }

  // ---- the Giver's illustration (last-resort hint) ------------------------------------------

  /**
   * "I need an illustration". Everything is decided here, never by the browser:
   *  - the seat (from the token) must be the Giver, and the word is the room's current word;
   *  - already asked this round → just the view again (no second image, no second penalty);
   *  - a cached picture (made in Studio, or drawn earlier for this activity and word) is reused: no AI call;
   *  - otherwise ONE request draws it (a lock key keeps simultaneous requests from paying twice), the picture is cached,
   *  - and only then is the score cap applied (atomically, on the room). A failed drawing changes nothing.
   */
  async requestIllustration(input: { activityId: string; group: unknown; token: unknown }): Promise<ActResult> {
    return (await this.guard(async (): Promise<ActResult> => {
      const group = normalizeGroup(input.group);
      if (!group) return fail("bad_group", "Invalid group.");
      const key = roomKey(input.activityId, group);
      type Read = { error: Fail } | { error?: undefined; cur: { room: Room; version: number }; seat: 0 | 1 };
      const read = async (): Promise<Read> => {
        const cur = parseRoom(await this.kv.get(key));
        if (!cur) return { error: (await this.loadActivity(input.activityId)) ? fail("unauthorized", "Please join the group again.") : fail("no_activity", NO_ACTIVITY) };
        const seat = typeof input.token === "string" ? seatFor(cur.room, input.token) : null;
        if (seat === null) return { error: fail("unauthorized", "Please join the group again.") };
        return { cur, seat };
      };
      const respond = async (room: Room, seat: 0 | 1, applied: boolean): Promise<ActResult> => {
        const partner = await this.touch(room, seat);
        return { ok: true, applied, view: await this.withPicture(room, buildView(room, seat, partner)) };
      };

      const first = await read();
      if (first.error) return first.error;
      const { room: r0 } = first.cur, seat = first.seat;
      const g0 = r0.game;
      if (!g0) return fail("bad_action", "The game hasn't started yet.");
      if (g0.giver !== seat) return fail("forbidden", "Only the Giver can ask for an illustration.");
      if (g0.phase !== "round" || !g0.currentWordId) return fail("bad_action", "There is no word in play.");
      const wordId = g0.currentWordId;
      if (g0.illustrationUsed) return respond(r0, seat, false);

      // 1. reuse a cached picture; 2. otherwise draw exactly one
      const cacheKey = imgKey(input.activityId, wordId);
      let src = await this.kv.get(cacheKey);
      if (!src) {
        const word = (await this.loadActivity(input.activityId))?.words.find((w) => w.id === wordId); // the SERVER decides the word
        if (!word) return fail("no_activity", NO_ACTIVITY);
        if (!this.opts.drawer) return fail("picture_failed", "Illustrations aren't available on this server. Your score is unchanged.");
        const lock = lockKey(input.activityId, wordId);
        if (await this.kv.cas(lock, 0, "1|lock", LOCK_TTL) /* "<version>|…": version 1 = held; released = empty = version 0 */) {
          try {
            src = await this.kv.get(cacheKey); // another request may have finished just before we got the lock
            if (!src) {
              const [perWord, perActivity] = [await this.kv.incr(wordTriesKey(input.activityId, wordId), ACTIVITY_TTL), await this.kv.incr(activityTriesKey(input.activityId), ACTIVITY_TTL)];
              if (perWord > MAX_DRAWS_PER_WORD || perActivity > MAX_DRAWS_PER_ACTIVITY) {
                return fail("picture_failed", "No more illustrations can be drawn for this word right now. Your score is unchanged — keep playing.");
              }
              src = (await this.opts.drawer(word)).src;
              await this.kv.set(cacheKey, src, ACTIVITY_TTL);
            }
          } catch (e) {
            if (e instanceof KvError) throw e;
            return fail("picture_failed", `${pictureFailureText(e)} Your score is unchanged — keep playing.`);
          } finally {
            await this.kv.set(lock, "", 1).catch(() => undefined); // release
          }
        } else {
          // Someone else is drawing this very word: wait for their picture instead of paying for a second one.
          const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
          const deadline = Date.now() + (this.opts.lockWaitMs ?? 45_000); // real time: the injected clock is for room timestamps
          while (!src && Date.now() < deadline) {
            await sleep(500);
            src = await this.kv.get(cacheKey);
          }
          if (!src) return fail("busy", "A picture is still being drawn. Try again in a moment. Your score is unchanged.");
        }
      }

      // 3. the picture exists: apply the score cap (server-side, once; refresh/retry/duplicate requests can't undo or repeat it)
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = await read();
        if (cur.error) return cur.error;
        const room = cloneRoom(cur.cur.room);
        const out = markIllustration(room, cur.seat, wordId, this.now());
        if (typeof out === "object") return out; // round ended / roles changed meanwhile: no penalty, picture not shown
        if (out === "already") return respond(cur.cur.room, cur.seat, false);
        if (await this.kv.cas(key, cur.cur.version, serialize(room), ROOM_TTL)) return respond(room, cur.seat, true);
        await sleep(10 + Math.random() * 30);
      }
      return fail("busy", "The classroom is busy. Please try again.");
    })) as ActResult;
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
            return { ok: true, token: input.token, seat, rejoined: true, view: await this.withPicture(cur.room, buildView(cur.room, seat, partner)) };
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
          return { ok: true, token, seat: claimed.seat, rejoined: false, view: await this.withPicture(room, buildView(room, claimed.seat, partner)) };
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
      return { ok: true, unchanged: false, view: await this.withPicture(cur.room, buildView(cur.room, seat, partner)) };
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
          return { ok: true, applied: false, view: await this.withPicture(cur.room, buildView(cur.room, seat, partner)) };
        }
        if (await this.kv.cas(key, cur.version, serialize(room), ROOM_TTL)) {
          if (out.left) return { ok: true, applied: true, view: null };
          const partner = await this.touch(room, seat);
          return { ok: true, applied: true, view: await this.withPicture(room, buildView(room, seat, partner)) };
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
  return (G.__vqsClassService ??= new ClassService(() => kvFromEnv(), Date.now, { drawer: envDrawer }));
}

/** Production drawer: the existing OpenAI image setup, read from the server environment at call time (never sent anywhere else). */
const envDrawer: Drawer = async (word) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new IllustrateError("no_ai", "Illustrations need the OpenAI key, which isn't set on this server.");
  return generateIllustration({ apiKey, model: process.env.OPENAI_IMAGE_MODEL, url: process.env.OPENAI_IMAGES_URL }, word);
};

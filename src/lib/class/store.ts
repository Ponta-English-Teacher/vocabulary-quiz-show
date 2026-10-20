import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { VocabWord } from "@/data/vocab";
import { cleanNames, createInitialState, gameReducer, type GameAction, type GameState } from "@/lib/game";
import { coerceWord } from "@/lib/studio/validation";
import type { ClassView, ClientAction, ErrorCode, SeatRole } from "./types";
import { redactForRole } from "./views";

/**
 * Authoritative in-memory classroom store.
 *
 * One Node process owns all rooms; phones talk to it over HTTP (see src/app/api/class).
 * It reuses the existing game reducer, so rules and scoring are identical to demo mode.
 *
 *  - Room identity = (activityId, group). Group "1" and "11" are different rooms, and the
 *    same group number in another activity is a different room.
 *  - A seat is claimed with a random session token (kept only by that phone). The token — never a
 *    URL parameter — decides which seat, and therefore which role, a request acts as.
 *  - NOT suitable for serverless hosting (instances don't share memory) — see README.
 */

export const PRESENCE_MS = 7_000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVITIES = 100;
const MAX_ROOMS_PER_ACTIVITY = 400;
const MAX_OPS = 200;
const MAX_NAME = 16;

export interface ClassActivity {
  id: string;
  title: string;
  words: VocabWord[];
  createdAt: number;
}

interface Seat {
  name: string;
  tokenHash: string;
  lastSeen: number;
}

interface Proposal {
  giverSeat: 0 | 1;
  by: 0 | 1;
}

interface Room {
  activityId: string;
  group: string;
  seats: [Seat | null, Seat | null];
  proposal: Proposal | null;
  game: GameState | null;
  version: number;
  presence: [boolean, boolean];
  ops: string[];
  updatedAt: number;
}

export type Fail = { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): Fail => ({ ok: false, code, message });

export type JoinResult = { ok: true; token: string; seat: 0 | 1; rejoined: boolean; view: ClassView } | Fail;
export type ViewResult = { ok: true; unchanged: false; view: ClassView } | { ok: true; unchanged: true; version: number } | Fail;
export type ActResult = { ok: true; applied: boolean; view: ClassView | null } | Fail;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function normalizeGroup(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 ? String(n) : null;
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return s || null;
}

const other = (s: 0 | 1): 0 | 1 => (s === 0 ? 1 : 0);

export class ClassStore {
  private activities = new Map<string, ClassActivity>();
  private rooms = new Map<string, Room>();

  constructor(private now: () => number = Date.now) {}

  // ---- activities ------------------------------------------------------------------

  createActivity(input: { title: unknown; words: unknown }): { ok: true; activity: ClassActivity } | Fail {
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
    this.purge();
    if (this.activities.size >= MAX_ACTIVITIES) return fail("bad_request", "Too many active class activities. Try again later.");
    const id = randomBytes(5).toString("hex"); // 10 hex chars
    const activity = { id, title: input.title.trim().slice(0, 100) || "Class activity", words, createdAt: this.now() };
    this.activities.set(id, activity);
    return { ok: true, activity };
  }

  getActivityInfo(id: string): { title: string; wordCount: number } | null {
    const a = this.activities.get(id);
    return a ? { title: a.title, wordCount: a.words.length } : null;
  }

  // ---- joining -------------------------------------------------------------------

  join(input: { activityId: string; group: unknown; name: unknown; token?: unknown }): JoinResult {
    const activity = this.activities.get(input.activityId);
    if (!activity) return fail("no_activity", "This class link isn't valid (or the server was restarted). Ask your teacher for a new link.");
    const group = normalizeGroup(input.group);
    if (!group) return fail("bad_group", "Enter your group number (1–999).");
    const key = `${activity.id}:${group}`;
    const now = this.now();

    // Returning player: a valid token reclaims its own seat, nothing else.
    const existing = this.rooms.get(key);
    if (existing && typeof input.token === "string") {
      const seat = this.seatFor(existing, input.token);
      if (seat !== null) {
        this.touch(existing, seat, now);
        return { ok: true, token: input.token, seat, rejoined: true, view: this.buildView(existing, activity, seat, now) };
      }
    }

    const name = cleanName(input.name);
    if (!name) return fail("bad_name", "Enter your name.");

    let room = existing;
    if (!room) {
      const count = [...this.rooms.values()].filter((r) => r.activityId === activity.id).length;
      if (count >= MAX_ROOMS_PER_ACTIVITY) return fail("full", "Too many groups in this activity.");
      room = { activityId: activity.id, group, seats: [null, null], proposal: null, game: null, version: 1, presence: [false, false], ops: [], updatedAt: now };
      this.rooms.set(key, room);
    }
    const free = room.seats[0] === null ? 0 : room.seats[1] === null ? 1 : null;
    if (free === null) return fail("full", `Group ${group} already has two players. Check your group number.`);

    const token = randomBytes(16).toString("hex");
    room.seats[free] = { name, tokenHash: hash(token), lastSeen: now };
    room.presence[free] = true;
    room.proposal = null;
    this.bump(room, now);
    return { ok: true, token, seat: free, rejoined: false, view: this.buildView(room, activity, free, now) };
  }

  // ---- reading state ------------------------------------------------------------------

  getView(input: { activityId: string; group: unknown; token: unknown; since?: number }): ViewResult {
    const ctx = this.auth(input);
    if (!ctx.ok) return ctx;
    const { room, activity, seat } = ctx;
    const now = this.now();
    this.touch(room, seat, now);
    if (input.since !== undefined && input.since === room.version) return { ok: true, unchanged: true, version: room.version };
    return { ok: true, unchanged: false, view: this.buildView(room, activity, seat, now) };
  }

  // ---- acting ----------------------------------------------------------------------

  act(input: { activityId: string; group: unknown; token: unknown; opId?: unknown; action: unknown }): ActResult {
    const ctx = this.auth(input);
    if (!ctx.ok) return ctx;
    const { room, activity, seat } = ctx;
    const now = this.now();
    this.touch(room, seat, now);

    const action = parseAction(input.action);
    if (!action) return fail("bad_action", "Unknown action.");

    // Idempotency: a retried request (same opId) is acknowledged but not applied again.
    if (typeof input.opId === "string" && input.opId) {
      if (room.ops.includes(input.opId)) return { ok: true, applied: false, view: this.buildView(room, activity, seat, now) };
      room.ops.push(input.opId);
      if (room.ops.length > MAX_OPS) room.ops.shift();
    }

    const role: SeatRole | null = room.game ? (room.game.giver === seat ? "giver" : "taker") : null;
    const denied = this.permission(action, role);
    if (denied) return denied;

    let applied = false;
    if (!room.game) {
      applied = this.lobbyAction(room, activity, seat, action);
      if (action.type === "LEAVE") {
        if (applied) this.bump(room, now);
        return { ok: true, applied, view: null };
      }
    } else {
      applied = this.gameAction(room, seat, action);
    }
    if (applied) this.bump(room, now);
    return { ok: true, applied, view: this.buildView(room, activity, seat, now) };
  }

  // ---- housekeeping -----------------------------------------------------------------

  /** Detect connect/disconnect transitions (so the partner's indicator updates) and drop stale data. */
  sweep(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      for (const s of [0, 1] as const) {
        const seat = room.seats[s];
        const connected = !!seat && now - seat.lastSeen < PRESENCE_MS;
        if (connected !== room.presence[s]) {
          room.presence[s] = connected;
          this.bump(room, now);
        }
      }
    }
    this.purge();
  }

  private purge(): void {
    const now = this.now();
    for (const [k, r] of this.rooms) if (now - r.updatedAt > ROOM_TTL_MS) this.rooms.delete(k);
    for (const [k, a] of this.activities) {
      if (now - a.createdAt > ACTIVITY_TTL_MS) {
        this.activities.delete(k);
        for (const [rk, r] of this.rooms) if (r.activityId === k) this.rooms.delete(rk);
      }
    }
  }

  // ---- internals --------------------------------------------------------------------

  private auth(input: { activityId: string; group: unknown; token: unknown }):
    | { ok: true; room: Room; activity: ClassActivity; seat: 0 | 1 }
    | Fail {
    const activity = this.activities.get(input.activityId);
    if (!activity) return fail("no_activity", "This class link isn't valid (or the server was restarted).");
    const group = normalizeGroup(input.group);
    if (!group) return fail("bad_group", "Invalid group.");
    const room = this.rooms.get(`${activity.id}:${group}`);
    if (!room || typeof input.token !== "string") return fail("unauthorized", "Please join the group again.");
    const seat = this.seatFor(room, input.token);
    if (seat === null) return fail("unauthorized", "Please join the group again.");
    return { ok: true, room, activity, seat };
  }

  private seatFor(room: Room, token: string): 0 | 1 | null {
    const h = hash(token);
    for (const s of [0, 1] as const) {
      const seat = room.seats[s];
      if (seat && sameHash(seat.tokenHash, h)) return s;
    }
    return null;
  }

  private touch(room: Room, seat: 0 | 1, now: number): void {
    const s = room.seats[seat]!;
    s.lastSeen = now;
    if (!room.presence[seat]) {
      room.presence[seat] = true;
      this.bump(room, now);
    }
  }

  private bump(room: Room, now: number): void {
    room.version++;
    room.updatedAt = now;
  }

  private permission(action: ClientAction, role: SeatRole | null): Fail | null {
    const need: Partial<Record<ClientAction["type"], SeatRole>> = {
      PICK: "giver", REVEAL_HINT: "giver", ADJUST_HINTS: "giver", GUESS: "taker",
    };
    const lobbyOnly = ["PROPOSE_ROLES", "CONFIRM_ROLES", "LEAVE"];
    if (role === null) {
      if (!lobbyOnly.includes(action.type)) return fail("bad_action", "The game hasn't started yet.");
      return null;
    }
    if (lobbyOnly.includes(action.type)) return fail("bad_action", "The game has already started.");
    const required = need[action.type];
    if (required && required !== role) {
      return fail("forbidden", action.type === "GUESS" ? "Only the Taker can answer." : "Only the Giver can do that.");
    }
    return null;
  }

  private lobbyAction(room: Room, activity: ClassActivity, seat: 0 | 1, action: ClientAction): boolean {
    if (action.type === "LEAVE") {
      room.seats[seat] = null;
      room.presence[seat] = false;
      room.proposal = null;
      return true;
    }
    if (!room.seats[0] || !room.seats[1]) return false;
    if (action.type === "PROPOSE_ROLES" ) {
      const giverSeat: 0 | 1 = action.giver === "me" ? seat : other(seat);
      if (room.proposal && room.proposal.giverSeat === giverSeat && room.proposal.by === seat) return false;
      room.proposal = { giverSeat, by: seat };
      return true;
    }
    if (action.type === "CONFIRM_ROLES") {
      // Only the partner of whoever proposed can confirm.
      if (!room.proposal || room.proposal.by === seat) return false;
      const started = gameReducer(createInitialState(), {
        type: "START",
        names: [room.seats[0].name, room.seats[1].name],
        words: activity.words,
      });
      room.game = { ...started, giver: room.proposal.giverSeat };
      room.proposal = null;
      return true;
    }
    return false;
  }

  private gameAction(room: Room, seat: 0 | 1, action: ClientAction): boolean {
    const game = room.game!;
    let mapped: GameAction | null = null;
    switch (action.type) {
      case "PICK": mapped = { type: "PICK", wordId: action.wordId }; break;
      case "REVEAL_HINT": mapped = { type: "REVEAL_HINT" }; break;
      case "ADJUST_HINTS": mapped = { type: "ADJUST_HINTS", delta: action.delta }; break;
      case "GUESS": mapped = { type: "GUESS", text: action.text }; break;
      case "SKIP": mapped = { type: "SKIP" }; break;
      case "NEXT": mapped = { type: "NEXT" }; break;
      case "CONTINUE": mapped = { type: "CONTINUE" }; break;
      case "PLAY_AGAIN":
        if (game.phase !== "final") return false;
        room.game = null;
        room.proposal = null;
        return true;
    }
    if (!mapped) return false;
    void seat;
    const next = gameReducer(game, mapped);
    if (next === game) return false; // wrong phase / invalid → nothing changes (e.g. a second answer can't score twice)
    room.game = next;
    return true;
  }

  private buildView(room: Room, activity: ClassActivity, seat: 0 | 1, now: number): ClassView {
    const me = room.seats[seat]!;
    const p = room.seats[other(seat)];
    const role: SeatRole | null = room.game ? (room.game.giver === seat ? "giver" : "taker") : null;
    const names = room.game ? room.game.players.map((x) => x.name) : [room.seats[0]?.name ?? "", room.seats[1]?.name ?? ""];
    const prop = room.proposal;
    return {
      version: room.version,
      activityTitle: activity.title,
      group: room.group,
      wordCount: activity.words.length,
      you: { seat, name: room.game ? room.game.players[seat].name : me.name },
      partner: p ? { name: room.game ? names[other(seat)] : p.name, connected: now - p.lastSeen < PRESENCE_MS } : null,
      stage: room.game ? "playing" : room.seats[0] && room.seats[1] ? "roles" : "waiting",
      role,
      proposal: prop
        ? {
            giverName: names[prop.giverSeat],
            takerName: names[other(prop.giverSeat)],
            youProposed: prop.by === seat,
            youAreGiver: prop.giverSeat === seat,
          }
        : null,
      game: room.game && role ? redactForRole(room.game, role) : null,
    };
  }
}

function parseAction(raw: unknown): ClientAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "PROPOSE_ROLES": return a.giver === "me" || a.giver === "partner" ? { type: "PROPOSE_ROLES", giver: a.giver } : null;
    case "CONFIRM_ROLES": case "LEAVE": case "REVEAL_HINT": case "SKIP": case "NEXT": case "CONTINUE": case "PLAY_AGAIN":
      return { type: a.type };
    case "PICK": return typeof a.wordId === "string" && a.wordId.length < 60 ? { type: "PICK", wordId: a.wordId } : null;
    case "ADJUST_HINTS": return a.delta === 1 || a.delta === -1 ? { type: "ADJUST_HINTS", delta: a.delta } : null;
    case "GUESS": return typeof a.text === "string" ? { type: "GUESS", text: a.text.slice(0, 100) } : null;
    default: return null;
  }
}

/** One store per server process, surviving hot reloads and shared by all route bundles. */
const G = globalThis as unknown as { __vqsClassStore?: ClassStore; __vqsSweeper?: ReturnType<typeof setInterval> };
export function getClassStore(): ClassStore {
  if (!G.__vqsClassStore) {
    G.__vqsClassStore = new ClassStore();
    G.__vqsSweeper = setInterval(() => G.__vqsClassStore?.sweep(), 3_000);
    G.__vqsSweeper.unref?.();
  }
  return G.__vqsClassStore;
}

export { cleanNames };

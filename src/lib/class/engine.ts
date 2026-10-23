import { createHash, timingSafeEqual } from "node:crypto";
import type { VocabWord } from "@/data/vocab";
import { createInitialState, gameReducer, type GameAction, type GameState } from "@/lib/game";
import type { ClassView, ClientAction, ErrorCode, SeatRole } from "./types";
import { redactForRole } from "./views";

/**
 * Pure classroom-room rules — no storage, no clock, no I/O. The service loads a Room from shared storage,
 * applies one of these functions to a copy, and writes it back with a version check.
 *
 *  - Room identity = (activityId, group). Group "1" and "11" are different rooms.
 *  - A seat is claimed with a random session token held only by that phone (only its hash is stored).
 *  - The seat — and therefore the role — comes from the token, never from anything the client sends.
 *  - Views are built per role, so the Taker never receives secrets and the Giver only the current word.
 */

export const MAX_OPS = 200;
const MAX_NAME = 16;

export interface Seat {
  name: string;
  tokenHash: string;
}
export interface Proposal {
  giverSeat: 0 | 1;
  by: 0 | 1;
}
export interface Room {
  activityId: string;
  group: string;
  title: string;
  wordCount: number;
  seats: [Seat | null, Seat | null];
  proposal: Proposal | null;
  game: GameState | null;
  /** A pending early-finish request. Lives with the room, so it survives refreshes and reconnects. `declined`: the partner said no. */
  endRequest?: { by: 0 | 1; declined?: boolean } | null;
  version: number;
  ops: string[];
  updatedAt: number;
}
export interface ClassActivity {
  id: string;
  title: string;
  words: VocabWord[];
  createdAt: number;
}

export type Fail = { ok: false; code: ErrorCode; message: string };
export const fail = (code: ErrorCode, message: string): Fail => ({ ok: false, code, message });

export const other = (s: 0 | 1): 0 | 1 => (s === 0 ? 1 : 0);
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
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

export function newRoom(activity: Pick<ClassActivity, "id" | "title" | "words">, group: string, now: number): Room {
  return {
    activityId: activity.id, group, title: activity.title, wordCount: activity.words.length,
    seats: [null, null], proposal: null, game: null, version: 1, ops: [], updatedAt: now,
  };
}

export const cloneRoom = (r: Room): Room => JSON.parse(JSON.stringify(r)) as Room;

export function seatFor(room: Room, token: string): 0 | 1 | null {
  const h = hashToken(token);
  for (const s of [0, 1] as const) {
    const seat = room.seats[s];
    if (seat && sameHash(seat.tokenHash, h)) return s;
  }
  return null;
}

const bump = (room: Room, now: number) => {
  room.version++;
  room.updatedAt = now;
};

/** Claim the first free seat. Mutates `room` (a copy). */
export function claimSeat(room: Room, name: string, tokenHash: string, now: number): { seat: 0 | 1 } | Fail {
  const free = room.seats[0] === null ? 0 : room.seats[1] === null ? 1 : null;
  if (free === null) return fail("full", `Group ${room.group} already has two players. Check your group number.`);
  room.seats[free] = { name, tokenHash };
  room.proposal = null;
  bump(room, now);
  return { seat: free };
}

export function parseAction(raw: unknown): ClientAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "PROPOSE_ROLES": return a.giver === "me" || a.giver === "partner" ? { type: "PROPOSE_ROLES", giver: a.giver } : null;
    case "CONFIRM_ROLES": case "LEAVE": case "REVEAL_HINT": case "SKIP": case "NEXT": case "CONTINUE": case "PLAY_AGAIN": case "REQUEST_END": case "CONFIRM_END": case "CANCEL_END":
      return { type: a.type };
    case "PICK": return typeof a.wordId === "string" && a.wordId.length < 60 ? { type: "PICK", wordId: a.wordId } : null;
    case "ADJUST_HINTS": return a.delta === 1 || a.delta === -1 ? { type: "ADJUST_HINTS", delta: a.delta } : null;
    case "GUESS": return typeof a.text === "string" ? { type: "GUESS", text: a.text.slice(0, 100) } : null;
    case "GUESS_JA": return typeof a.text === "string" ? { type: "GUESS_JA", text: a.text.slice(0, 100) } : null;
    default: return null;
  }
}

function permission(action: ClientAction, role: SeatRole | null): Fail | null {
  const need: Partial<Record<ClientAction["type"], SeatRole>> = { PICK: "giver", REVEAL_HINT: "giver", ADJUST_HINTS: "giver", GUESS: "taker", GUESS_JA: "taker" };
  const lobbyOnly = ["PROPOSE_ROLES", "CONFIRM_ROLES", "LEAVE"];
  if (role === null) {
    if (!lobbyOnly.includes(action.type)) return fail("bad_action", "The game hasn't started yet.");
    return null;
  }
  if (lobbyOnly.includes(action.type)) return fail("bad_action", "The game has already started.");
  const required = need[action.type];
  if (required && required !== role) {
    return fail("forbidden", action.type === "GUESS" || action.type === "GUESS_JA" ? "Only the Taker can answer." : "Only the Giver can do that.");
  }
  return null;
}

function lobbyAction(room: Room, words: VocabWord[] | null, seat: 0 | 1, action: ClientAction): boolean {
  if (action.type === "LEAVE") {
    room.seats[seat] = null;
    room.proposal = null;
    return true;
  }
  if (!room.seats[0] || !room.seats[1]) return false;
  if (action.type === "PROPOSE_ROLES") {
    const giverSeat: 0 | 1 = action.giver === "me" ? seat : other(seat);
    if (room.proposal && room.proposal.giverSeat === giverSeat && room.proposal.by === seat) return false;
    room.proposal = { giverSeat, by: seat };
    return true;
  }
  if (action.type === "CONFIRM_ROLES") {
    // Only the partner of whoever proposed can confirm.
    if (!room.proposal || room.proposal.by === seat || !words) return false;
    // Study-page translations are not game data: the game never holds them, so no screen can show or score them.
    const gameWords = words.map(({ studyJa: _studyJa, ...rest }) => (void _studyJa, rest));
    const started = gameReducer(createInitialState(), { type: "START", names: [room.seats[0].name, room.seats[1].name], words: gameWords });
    room.game = { ...started, giver: room.proposal.giverSeat };
    room.proposal = null;
    return true;
  }
  return false;
}

/** Both partners agree: finish THIS pair's game now. Scores are whatever finished rounds produced. */
function endGame(room: Room): boolean {
  const next = gameReducer(room.game!, { type: "END_EARLY" });
  if (next === room.game) return false;
  room.game = next;
  room.endRequest = null;
  return true;
}

function endAction(room: Room, seat: 0 | 1, action: ClientAction): boolean {
  const game = room.game!;
  if (game.phase === "final") return false; // the result is recorded: nothing can change it
  const req = room.endRequest ?? null;
  const live = req && !req.declined ? req : null;
  if (action.type === "REQUEST_END") {
    if (live && live.by === seat) return false; // duplicate request
    if (live) return endGame(room); // the partner had already asked: two requests are agreement (simultaneous presses)
    room.endRequest = { by: seat };
    return true;
  }
  if (action.type === "CONFIRM_END") return live && live.by !== seat ? endGame(room) : false;
  if (action.type === "CANCEL_END") {
    if (!req) return false;
    if (req.by === seat) { room.endRequest = null; return true; } // withdraw, or dismiss a "declined" notice
    if (req.declined) return false;
    room.endRequest = { by: req.by, declined: true }; // the partner says "keep playing"
    return true;
  }
  return false;
}

function gameAction(room: Room, seat: 0 | 1, action: ClientAction): boolean {
  const game = room.game!;
  if (action.type === "REQUEST_END" || action.type === "CONFIRM_END" || action.type === "CANCEL_END") return endAction(room, seat, action);
  let mapped: GameAction | null = null;
  switch (action.type) {
    case "PICK": mapped = { type: "PICK", wordId: action.wordId }; break;
    case "REVEAL_HINT": mapped = { type: "REVEAL_HINT" }; break;
    case "ADJUST_HINTS": mapped = { type: "ADJUST_HINTS", delta: action.delta }; break;
    case "GUESS": mapped = { type: "GUESS", text: action.text }; break;
    case "GUESS_JA": mapped = { type: "GUESS_JA", text: action.text }; break;
    case "SKIP": mapped = { type: "SKIP" }; break;
    case "NEXT": mapped = { type: "NEXT" }; break;
    case "CONTINUE": mapped = { type: "CONTINUE" }; break;
    case "PLAY_AGAIN":
      if (game.phase !== "final") return false;
      room.game = null;
      room.proposal = null;
      room.endRequest = null;
      return true;
  }
  if (!mapped) return false;
  const next = gameReducer(game, mapped);
  if (next === game) return false; // wrong phase / invalid → nothing changes (a second answer can't score twice)
  room.game = next;
  if (next.phase === "final") room.endRequest = null;
  return true;
}

/**
 * SERVER-ONLY: the picture was made available to the Giver, so the word's score is capped from now on.
 * Not reachable through parseAction/applyAction, so no phone can send it. Checks again that this seat is still the Giver,
 * that the round is still running and that the word in play is still the one the picture was made for.
 */
export function markIllustration(room: Room, seat: 0 | 1, wordId: string, now: number): "applied" | "already" | Fail {
  const game = room.game;
  if (!game) return fail("bad_action", "The game hasn't started yet.");
  if (game.giver !== seat) return fail("forbidden", "Only the Giver can ask for an illustration.");
  if (game.phase !== "round" || game.currentWordId !== wordId) return fail("bad_action", "That round has already ended, so your score is unchanged.");
  if (game.illustrationUsed) return "already";
  const next = gameReducer(game, { type: "ILLUSTRATION_USED" });
  if (next === game) return fail("bad_action", "That round has already ended, so your score is unchanged.");
  room.game = next;
  bump(room, now);
  return "applied";
}

export type ActOutcome =
  | { error: Fail }
  | { applied: false; duplicate: boolean }
  | { applied: true; left: boolean };

/**
 * Apply one action by the player in `seat`. Mutates `room` (a copy) and bumps its version only when something changed.
 * `words` is needed only for CONFIRM_ROLES (the activity's words are fetched lazily by the service).
 */
export function applyAction(room: Room, words: VocabWord[] | null, seat: 0 | 1, action: ClientAction, opId: unknown, now: number): ActOutcome {
  // Idempotency: a retried request (same opId) is acknowledged but not applied again.
  if (typeof opId === "string" && opId && room.ops.includes(opId)) return { applied: false, duplicate: true };

  const role: SeatRole | null = room.game ? (room.game.giver === seat ? "giver" : "taker") : null;
  const denied = permission(action, role);
  if (denied) return { error: denied };

  const applied = room.game ? gameAction(room, seat, action) : lobbyAction(room, words, seat, action);
  if (!applied) return { applied: false, duplicate: false };
  if (typeof opId === "string" && opId) {
    room.ops.push(opId);
    if (room.ops.length > MAX_OPS) room.ops.shift();
  }
  bump(room, now);
  return { applied: true, left: action.type === "LEAVE" };
}

function endViewFor(room: Room, seat: 0 | 1): ClassView["end"] {
  const req = room.endRequest;
  if (!req || !room.game || room.game.phase === "final") return null;
  if (req.by === seat) return req.declined ? "declined" : "requested-by-you";
  return req.declined ? null : "requested-by-partner";
}

/** What this player's phone is told. `partnerConnected`: true/false, or null when there is no partner yet. */
export function buildView(room: Room, seat: 0 | 1, partnerConnected: boolean | null): ClassView {
  const me = room.seats[seat]!;
  const p = room.seats[other(seat)];
  const role: SeatRole | null = room.game ? (room.game.giver === seat ? "giver" : "taker") : null;
  const names = room.game ? room.game.players.map((x) => x.name) : [room.seats[0]?.name ?? "", room.seats[1]?.name ?? ""];
  const prop = room.proposal;
  return {
    version: room.version,
    activityTitle: room.title,
    group: room.group,
    wordCount: room.wordCount,
    you: { seat, name: room.game ? room.game.players[seat].name : me.name },
    partner: p ? { name: room.game ? names[other(seat)] : p.name, connected: partnerConnected === true } : null,
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
    end: endViewFor(room, seat),
    game: room.game && role ? redactForRole(room.game, role) : null,
  };
}

import type { GameState } from "@/lib/game";

/** What a phone is told. Built on the server per player — never contains data that player may not see. */
export type ClassStage = "waiting" | "roles" | "playing";
export type SeatRole = "giver" | "taker";

export interface ClassView {
  /** Bumps on every change (including partner connect/disconnect). Clients poll with `since`. */
  version: number;
  activityTitle: string;
  group: string;
  wordCount: number;
  you: { seat: 0 | 1; name: string };
  partner: { name: string; connected: boolean } | null;
  stage: ClassStage;
  /** Only set while playing. Decided by the server from the session token. */
  role: SeatRole | null;
  proposal: {
    giverName: string;
    takerName: string;
    youProposed: boolean;
    youAreGiver: boolean;
  } | null;
  /** The early-finish request, from this player's point of view. */
  end: "requested-by-you" | "requested-by-partner" | "declined" | null;
  /** Role-filtered game state (see views.ts). */
  game: GameState | null;
}

export type ClientAction =
  | { type: "PROPOSE_ROLES"; giver: "me" | "partner" }
  | { type: "CONFIRM_ROLES" }
  | { type: "LEAVE" }
  | { type: "PICK"; wordId: string }
  | { type: "REVEAL_HINT" }
  | { type: "ADJUST_HINTS"; delta: 1 | -1 }
  | { type: "GUESS"; text: string }
  | { type: "GUESS_JA"; text: string }
  | { type: "SKIP" }
  | { type: "NEXT" }
  | { type: "CONTINUE" }
  | { type: "PLAY_AGAIN" }
  /** Early finish: either partner asks; the OTHER partner confirms (CONFIRM_END) or declines (CANCEL_END). The asker can withdraw with CANCEL_END. */
  | { type: "REQUEST_END" }
  | { type: "CONFIRM_END" }
  | { type: "CANCEL_END" };

export type ErrorCode =
  | "no_activity" | "no_room" | "bad_group" | "bad_name" | "full"
  | "unauthorized" | "forbidden" | "bad_action" | "bad_request" | "busy" | "unavailable" | "picture_failed";

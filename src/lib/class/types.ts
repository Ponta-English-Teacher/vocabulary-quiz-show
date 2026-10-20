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
  | { type: "SKIP" }
  | { type: "NEXT" }
  | { type: "CONTINUE" }
  | { type: "PLAY_AGAIN" };

export type ErrorCode =
  | "no_activity" | "no_room" | "bad_group" | "bad_name" | "full"
  | "unauthorized" | "forbidden" | "bad_action" | "bad_request" | "busy" | "unavailable";

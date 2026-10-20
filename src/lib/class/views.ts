import type { GameState } from "@/lib/game";
import { redactForTaker } from "@/lib/game";
import type { SeatRole } from "./types";

const BLANK = { word: "", accept: [] as string[], meaning: "", example: "" };

/**
 * The Giver may see ONLY the word currently in play (and words already solved/skipped).
 * Every other unsolved word is blanked, so even the Giver's network traffic can't reveal the future.
 */
export function redactForGiver(state: GameState): GameState {
  const words = state.words.map((w) => {
    const pending = state.statuses[w.id] === "pending";
    const inPlay = state.phase === "round" && w.id === state.currentWordId;
    if (!pending || inPlay) return w;
    return { ...w, ...BLANK, hints: w.hints.map(() => "") };
  });
  return { ...state, words };
}

export function redactForRole(state: GameState, role: SeatRole): GameState {
  return role === "giver" ? redactForGiver(state) : redactForTaker(state);
}

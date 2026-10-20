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

/**
 * Words that are already finished stay visible BY NAME (the board and the final recap show them), but their
 * definition, example and hints are only sent while that word is on the reveal screen. Otherwise an earlier word's
 * example sentence ("Can I borrow your scissors…") could give away a later target word.
 */
export function scrubFinished(state: GameState): GameState {
  const words = state.words.map((w) => {
    const finished = state.statuses[w.id] !== "pending";
    const showing = state.phase === "reveal" && w.id === state.currentWordId;
    if (!finished || showing) return w;
    return { ...w, ...BLANK, hints: w.hints.map(() => "") };
  });
  return { ...state, words: words.map((w, i) => ({ ...w, word: state.words[i].word })) };
}

export function redactForRole(state: GameState, role: SeatRole): GameState {
  return scrubFinished(role === "giver" ? redactForGiver(state) : redactForTaker(state));
}

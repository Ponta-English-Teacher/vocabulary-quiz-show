import type { GameState } from "@/lib/game";
import { redactForTaker } from "@/lib/game";
import type { SeatRole } from "./types";

const BLANK = { word: "", accept: [] as string[], meaning: "", example: "", ja: [] as string[], giverInfo: undefined, illustration: undefined };

/**
 * The Giver may see ONLY the word currently in play (and words already solved/skipped).
 * Every other unsolved word is blanked, so even the Giver's network traffic can't reveal the future.
 * The approved Japanese answers are withheld from the Giver too while the word is in play: they are answer data for the
 * Taker's Japanese box, and a Giver who could read them could simply say them aloud.
 */
export function redactForGiver(state: GameState): GameState {
  const words = state.words.map((w) => {
    const pending = state.statuses[w.id] === "pending";
    const inPlay = state.phase === "round" && w.id === state.currentWordId;
    if (inPlay) return { ...w, ja: [], illustration: undefined };
    if (!pending) return w;
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

/**
 * No picture (and no "a picture exists" marker) ever travels with the ordinary game state. The server adds the Giver's
 * picture afterwards, to the Giver only, and only once the Giver has asked for it (see ClassService.withPicture).
 */
export function redactForRole(state: GameState, role: SeatRole): GameState {
  const safe = scrubFinished(role === "giver" ? redactForGiver(state) : redactForTaker(state));
  return { ...safe, words: safe.words.map((w) => (w.illustration ? { ...w, illustration: undefined } : w)) };
}

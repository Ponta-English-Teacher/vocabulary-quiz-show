import type { VocabWord } from "@/data/vocab";
import { checkAnswer } from "./answer";
import { giverPointsFor, pointsForHints } from "./scoring";

/**
 * Pure, serialisable game logic. No React, no browser APIs.
 *
 * Because state is plain data and every change is an action, the same reducer can
 * later run on a server (or one "host" phone) and be mirrored to both devices —
 * see transport.ts.
 */

export type Phase = "welcome" | "switch" | "board" | "round" | "reveal" | "final";
export type PlayerIndex = 0 | 1;
export type WordStatus = "pending" | "solved" | "skipped";

export interface Player {
  name: string;
  score: number;
}

export interface Feedback {
  kind: "wrong" | "close";
  guess: string;
  /** Increments with every miss, so the UI can re-trigger animations. */
  n: number;
}

export interface RoundResult {
  wordId: string;
  outcome: "solved" | "skipped";
  giver: PlayerIndex;
  taker: PlayerIndex;
  hintsUsed: number;
  wrongGuesses: number;
  takerPoints: number;
  giverPoints: number;
}

export interface GameState {
  phase: Phase;
  words: VocabWord[];
  players: [Player, Player];
  /** Who is the Giver for the current / upcoming word. The other is the Taker. */
  giver: PlayerIndex;
  statuses: Record<string, WordStatus>;
  currentWordId: string | null;
  /** How many prepared hints have been revealed for the current word. */
  revealedHints: number;
  /** Prepared hints revealed + spoken hints added by hand. */
  hintsUsed: number;
  wrongGuesses: number;
  feedback: Feedback | null;
  lastResult: RoundResult | null;
  history: RoundResult[];
  /** Why the 'switch' screen is showing. */
  switchKind: "intro" | "swap" | null;
}

export type GameAction =
  | { type: "START"; names: [string, string]; words: VocabWord[] }
  | { type: "PICK"; wordId: string }
  | { type: "REVEAL_HINT" }
  | { type: "ADJUST_HINTS"; delta: 1 | -1 }
  | { type: "GUESS"; text: string }
  | { type: "SKIP" }
  | { type: "NEXT" }
  | { type: "CONTINUE" }
  | { type: "RESET" };

export const MAX_NAME_LENGTH = 16;

export function createInitialState(): GameState {
  return {
    phase: "welcome",
    words: [],
    players: [
      { name: "Player 1", score: 0 },
      { name: "Player 2", score: 0 },
    ],
    giver: 0,
    statuses: {},
    currentWordId: null,
    revealedHints: 0,
    hintsUsed: 0,
    wrongGuesses: 0,
    feedback: null,
    lastResult: null,
    history: [],
    switchKind: null,
  };
}

export function cleanNames(names: [string, string]): [string, string] {
  const a = names[0].trim().slice(0, MAX_NAME_LENGTH) || "Player 1";
  let b = names[1].trim().slice(0, MAX_NAME_LENGTH) || "Player 2";
  if (b.toLowerCase() === a.toLowerCase()) b = `${b.slice(0, MAX_NAME_LENGTH - 2)} 2`;
  return [a, b];
}

export const takerOf = (giver: PlayerIndex): PlayerIndex => (giver === 0 ? 1 : 0);

export function currentWord(state: GameState): VocabWord | null {
  return state.words.find((w) => w.id === state.currentWordId) ?? null;
}

export function remainingCount(state: GameState): number {
  return state.words.filter((w) => state.statuses[w.id] === "pending").length;
}

export function completedCount(state: GameState): number {
  return state.words.length - remainingCount(state);
}

function finishRound(
  state: GameState,
  outcome: RoundResult["outcome"],
): GameState {
  const word = currentWord(state);
  if (!word) return state;
  const taker = takerOf(state.giver);
  const solved = outcome === "solved";
  const takerPoints = solved ? pointsForHints(state.hintsUsed) : 0;
  const giverPoints = solved ? giverPointsFor(takerPoints) : 0;
  const result: RoundResult = {
    wordId: word.id,
    outcome,
    giver: state.giver,
    taker,
    hintsUsed: state.hintsUsed,
    wrongGuesses: state.wrongGuesses,
    takerPoints,
    giverPoints,
  };
  const players: [Player, Player] = [{ ...state.players[0] }, { ...state.players[1] }];
  players[taker].score += takerPoints;
  players[state.giver].score += giverPoints;
  return {
    ...state,
    phase: "reveal",
    players,
    statuses: { ...state.statuses, [word.id]: solved ? "solved" : "skipped" },
    feedback: null,
    lastResult: result,
    history: [...state.history, result],
  };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "START": {
      if (action.words.length === 0) return state;
      const [a, b] = cleanNames(action.names);
      return {
        ...createInitialState(),
        phase: "switch",
        switchKind: "intro",
        words: action.words,
        players: [
          { name: a, score: 0 },
          { name: b, score: 0 },
        ],
        statuses: Object.fromEntries(action.words.map((w) => [w.id, "pending" as const])),
      };
    }

    case "CONTINUE":
      if (state.phase !== "switch") return state;
      return { ...state, phase: "board", switchKind: null };

    case "PICK": {
      if (state.phase !== "board") return state;
      if (state.statuses[action.wordId] !== "pending") return state;
      return {
        ...state,
        phase: "round",
        currentWordId: action.wordId,
        revealedHints: 0,
        hintsUsed: 0,
        wrongGuesses: 0,
        feedback: null,
      };
    }

    case "REVEAL_HINT": {
      const word = currentWord(state);
      if (state.phase !== "round" || !word) return state;
      if (state.revealedHints >= word.hints.length) return state;
      return {
        ...state,
        revealedHints: state.revealedHints + 1,
        hintsUsed: state.hintsUsed + 1,
      };
    }

    case "ADJUST_HINTS": {
      if (state.phase !== "round") return state;
      // A hint that has been revealed can't be "un-given"; only spoken ones can be undone.
      const hintsUsed = Math.max(state.revealedHints, state.hintsUsed + action.delta);
      return { ...state, hintsUsed };
    }

    case "GUESS": {
      const word = currentWord(state);
      if (state.phase !== "round" || !word) return state;
      const verdict = checkAnswer(action.text, word);
      if (verdict === "empty") return state;
      if (verdict === "correct") return finishRound(state, "solved");
      const wrongGuesses = state.wrongGuesses + 1;
      return {
        ...state,
        wrongGuesses,
        feedback: { kind: verdict, guess: action.text.trim(), n: wrongGuesses },
      };
    }

    case "SKIP":
      if (state.phase !== "round") return state;
      return finishRound(state, "skipped");

    case "NEXT": {
      if (state.phase !== "reveal") return state;
      if (remainingCount(state) === 0) return { ...state, phase: "final" };
      return {
        ...state,
        phase: "switch",
        switchKind: "swap",
        giver: takerOf(state.giver),
        currentWordId: null,
      };
    }

    case "RESET":
      return createInitialState();
  }
}

export type FinalResult =
  | { kind: "winner"; winner: PlayerIndex }
  | { kind: "tie" };

export function getFinalResult(players: [Player, Player]): FinalResult {
  if (players[0].score === players[1].score) return { kind: "tie" };
  return { kind: "winner", winner: players[0].score > players[1].score ? 0 : 1 };
}

/**
 * What the Taker's device is allowed to know. Hides the text of every word that
 * is still unsolved (and the current word until the round is over).
 * In a real paired setup the server/host would send ONLY this to the Taker.
 */
export function redactForTaker(state: GameState): GameState {
  const words = state.words.map((w) => {
    const open =
      state.statuses[w.id] === "pending" && !(state.phase === "reveal" && w.id === state.currentWordId);
    if (!open) return w;
    return {
      ...w,
      word: "",
      accept: [],
      meaning: "",
      example: "",
      hints: w.hints.map(() => ""),
    };
  });
  return { ...state, words };
}

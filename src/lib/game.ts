import type { VocabWord } from "@/data/vocab";
import { checkAnswer } from "./answer";
import { checkJapaneseAnswer } from "./japanese";
import { FREE_HINTS, giverPointsFor, takerPointsFor, type AnswerLanguage } from "./scoring";

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
  /**
   * wrong / close          — a miss (counted, never penalised)
   * not-japanese           — the Japanese box got something that isn't Japanese (not counted)
   * no-ja-credit           — this word has no approved Japanese equivalent, so Japanese can't score (not counted)
   */
  kind: "wrong" | "close" | "not-japanese" | "no-ja-credit";
  /** Which answer box the student used. */
  lang: AnswerLanguage;
  guess: string;
  /** Increments with every feedback message, so the UI can re-trigger animations. */
  n: number;
}

export interface RoundResult {
  wordId: string;
  outcome: "solved" | "skipped";
  giver: PlayerIndex;
  taker: PlayerIndex;
  /** Extra (paid) hints used — the free opening hint is not counted. */
  hintsUsed: number;
  wrongGuesses: number;
  takerPoints: number;
  giverPoints: number;
  /** Language of the correct answer (absent for a skipped word and for results saved before Japanese answers existed). */
  answeredIn?: AnswerLanguage;
}

export interface GameState {
  phase: Phase;
  words: VocabWord[];
  players: [Player, Player];
  /** Who is the Giver for the current / upcoming word. The other is the Taker. */
  giver: PlayerIndex;
  statuses: Record<string, WordStatus>;
  currentWordId: string | null;
  /** How many prepared hints are showing for the current word. The free opening hint is showing from the start. */
  revealedHints: number;
  /** PAID hints: extra prepared hints revealed + spoken hints added by hand. The opening hint never counts. */
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
  | { type: "GUESS_JA"; text: string }
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

/** Prepared hints beyond the free opening hint that are showing now. */
export const paidRevealedHints = (state: GameState): number => Math.max(0, state.revealedHints - FREE_HINTS);

/** Spoken hints the Giver added with the + button. */
export const spokenHints = (state: GameState): number => state.hintsUsed - paidRevealedHints(state);

const nextFeedbackN = (state: GameState) => (state.feedback?.n ?? 0) + 1;

function finishRound(
  state: GameState,
  outcome: RoundResult["outcome"],
  lang: AnswerLanguage = "en",
): GameState {
  const word = currentWord(state);
  if (!word) return state;
  const taker = takerOf(state.giver);
  const solved = outcome === "solved";
  const takerPoints = solved ? takerPointsFor(state.hintsUsed, lang) : 0;
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
    ...(solved ? { answeredIn: lang } : {}),
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
      const picked = state.words.find((w) => w.id === action.wordId);
      return {
        ...state,
        phase: "round",
        currentWordId: action.wordId,
        // The opening hint is on screen from the first moment and is free (it is prepared data — no AI call).
        revealedHints: Math.min(FREE_HINTS, picked?.hints.length ?? 0),
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
      const hintsUsed = Math.max(paidRevealedHints(state), state.hintsUsed + action.delta);
      return { ...state, hintsUsed };
    }

    case "GUESS": {
      const word = currentWord(state);
      if (state.phase !== "round" || !word) return state;
      const verdict = checkAnswer(action.text, word);
      if (verdict === "empty") return state;
      if (verdict === "correct") return finishRound(state, "solved");
      return {
        ...state,
        wrongGuesses: state.wrongGuesses + 1,
        feedback: { kind: verdict, lang: "en", guess: action.text.trim(), n: nextFeedbackN(state) },
      };
    }

    case "GUESS_JA": {
      const word = currentWord(state);
      if (state.phase !== "round" || !word) return state;
      const verdict = checkJapaneseAnswer(action.text, word.ja);
      if (verdict === "empty") return state;
      if (verdict === "correct") return finishRound(state, "solved", "ja");
      const feedback: Feedback = {
        kind: verdict === "wrong" ? "wrong" : verdict === "unavailable" ? "no-ja-credit" : "not-japanese",
        lang: "ja",
        guess: action.text.trim(),
        n: nextFeedbackN(state),
      };
      // Only a real Japanese miss counts as a wrong guess; "no equivalent on file" and "that isn't Japanese" don't.
      return { ...state, wrongGuesses: state.wrongGuesses + (verdict === "wrong" ? 1 : 0), feedback };
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
    const inPlay = state.phase === "round" && w.id === state.currentWordId;
    return {
      ...w,
      word: "",
      accept: [],
      meaning: "",
      example: "",
      // The hints the Giver has revealed (the free opening hint included) are on both screens; the rest stay blank.
      hints: w.hints.map((h, i) => (inPlay && i < state.revealedHints ? h : "")),
      // Same length, empty text: the Taker's phone can tell whether Japanese credit exists, never what the answers are.
      ja: (w.ja ?? []).map(() => ""),
      giverInfo: undefined,
      // The Giver's private picture: never on the Taker's screen while the word is unsolved.
      illustration: undefined,
    };
  });
  return { ...state, words };
}

import type { CefrLevel, PartOfSpeech } from "@/data/vocab";

/**
 * The independent Vocabulary Quiz Show question bank (Phase 1: pure data rules only; nothing here touches storage, Redis or the network).
 *
 * One BankWord = one target word with FOUR spoken hints, written for explain-and-guess play between two students.
 * Only `approved` words may be used in a game. Imports always arrive as `draft`; a teacher approves explicitly.
 */
export const BANK_FORMAT = "vocabulary-quiz-show/words";
export const BANK_VERSION = 1;

export const BANK_STATUSES = ["draft", "approved", "archived"] as const;
export type BankStatus = (typeof BANK_STATUSES)[number];

/** Exactly four hints. Hint 1 is the free opening hint (least helpful); hint 4 is the most helpful. */
export const HINT_COUNT = 4;
export type FourHints = readonly [string, string, string, string];

export interface BankWord {
  /** Opaque unique id. Never derived from the word (the Taker's view exposes ids). */
  id: string;
  /** The target word or phrase, as the Giver sees it. */
  word: string;
  /** Other spellings or forms that count as correct (e.g. "colour" / "color"). */
  accept: string[];
  partOfSpeech: PartOfSpeech;
  /** Free-text topic label (shown to the Taker as a free clue in play). */
  category: string;
  cefr: CefrLevel;
  /** Optional narrower topic, for filtering. */
  topic?: string;
  /** Optional Japanese meaning for the GIVER only. Never sent to the Taker, never used for scoring. */
  giverJa?: string;
  /** Optional plain-English meaning and example for the Giver. */
  meaning?: string;
  example?: string;
  hints: FourHints;
  status: BankStatus;
  /** Where it came from: written in the bank, imported from a file, or migrated from Classroom Quiz Show. */
  source: "file" | "classroom-quiz-show" | "manual";
  sourceId?: string;
  createdAt: string;
  updatedAt: string;
  /** When a teacher approved it (cleared whenever the content is edited). */
  approvedAt?: string;
  /** Status before it was archived, so Restore can put it back (an approved word returns as draft: it must be re-approved). */
  archivedFrom?: Exclude<BankStatus, "archived">;
}

export type Severity = "error" | "warning";

export interface BankIssue {
  severity: Severity;
  /** Machine-readable reason. */
  code: string;
  field: "word" | "accept" | "partOfSpeech" | "cefr" | "category" | "topic" | "giverJa" | "meaning" | "example" | "hints" | "status";
  /** 0-based hint position, for hint problems. */
  hintIndex?: number;
  message: string;
}

import type { CefrLevel, VocabWord } from "@/data/vocab";

/** What the teacher and AI have agreed about the activity so far. Built up through conversation. */
export interface Brief {
  /** Vocabulary area, e.g. "Less common fruits". Empty until known. */
  topic: string;
  /** Intended OVERALL communication difficulty of the activity — not a limit on each word's level. */
  level: CefrLevel | null;
  objectives: string[];
  /** Notes about the learners, e.g. "Japanese students who recognise but can't produce". */
  learnerFocus: string;
  /** How many ten-word sets to generate. */
  numSets: number;
  /** Words or themes to avoid. */
  avoid: string[];
  /** The teacher's requested mix, e.g. "both familiar everyday and less common specialised words". Binding. */
  balance: string;
  /** True while the teacher asked to discuss candidates first and has NOT yet approved generating. */
  approvalPending: boolean;
  /** The kind of words the teacher asked for, in plain terms: "objects and utensils (nouns)", "actions (verbs)", … */
  wordType: string;
  /** The words currently on the table in the discussion (maintained by the AI, shown to the teacher). */
  candidates: string[];
  /** The same candidates grouped by familiarity (the teacher's/learners' sense of it — NOT CEFR cut-offs). */
  candidateBands: CandidateBands;
  /** Candidate words the teacher added or typed by hand. The AI may never drop them when the conversation continues. */
  pinnedCandidates: string[];
  /** Candidate words the teacher deleted or replaced. The AI may never put them back. */
  removedCandidates: string[];
  /** Set by the SERVER when the teacher approves: the exact words generation must use, unchanged. */
  approvedWords: string[];
}

export interface CandidateBands {
  familiar: string[];
  moderate: string[];
  unfamiliar: string[];
}
export const EMPTY_BANDS: CandidateBands = { familiar: [], moderate: [], unfamiliar: [] };

export const EMPTY_BRIEF: Brief = {
  topic: "",
  level: null,
  objectives: [],
  learnerFocus: "",
  numSets: 1,
  avoid: [],
  balance: "",
  approvalPending: false,
  wordType: "",
  candidates: [],
  candidateBands: { familiar: [], moderate: [], unfamiliar: [] },
  pinnedCandidates: [],
  removedCandidates: [],
  approvedWords: [],
};

/** The most words in one set (and the size of a full AI-written set). A set may hold anything from MIN_SET_WORDS to SET_SIZE. */
export const SET_SIZE = 10;
export const MIN_SET_WORDS = 1;
/** The most candidate words on the table at once. */
export const MAX_CANDIDATES = 20;
export const MAX_SETS_PER_REQUEST = 5;

export interface ChatMessage {
  role: "teacher" | "ai";
  text: string;
}

export type SetStatus = "draft" | "approved";

/** An approved word that has no finished item yet (the AI failed or the item failed validation). Kept so it is never silently lost. */
export interface MissingItem {
  word: string;
  /** Why it failed, in plain words. */
  reason: string;
  /** Where it belongs in the set (its place in the teacher's approved list). */
  index: number;
}

export interface StudioSet {
  id: string;
  title: string;
  status: SetStatus;
  words: VocabWord[];
  /** How many words the teacher approved for this set (so "9 approved · 7 written · 2 failed" can always be shown). Older sets lack it. */
  requested?: number;
  /** Ids of approved words whose hints failed validation when generated. They stay in the set but block approval until their hints are fixed. */
  flagged?: string[];
  /** Hints the teacher typed or changed by hand: word id → hint indexes (0-based). AI rewrites and repairs never replace these. */
  handHints?: Record<string, number[]>;
  /** Approved words that still have no item. While any exist the set cannot be approved or hosted. */
  missing?: MissingItem[];
  /** Word ids the teacher has locked: whole-set regeneration never replaces these. */
  lockedIds: string[];
}

export interface Activity {
  id: string;
  title: string;
  brief: Brief;
  messages: ChatMessage[];
  sets: StudioSet[];
  createdAt: string;
  updatedAt: string;
  version: 1;
}

/** An action the AI conversation asks the app to run (only when the teacher explicitly asked). */
export type StudioCommand =
  | { type: "generate" }
  | { type: "regenerate-set"; instruction?: string }
  | { type: "replace-word"; position: number; instruction?: string }
  | { type: "regenerate-hints"; position: number; instruction?: string };

export interface ChatResult {
  reply: string;
  brief: Brief;
  /** True when the brief is complete enough to generate. */
  ready: boolean;
  command: StudioCommand | null;
}

export interface SetContext {
  /** The set currently on screen, so "replace #3" can be resolved. */
  words: { position: number; word: string; cefr: string }[];
}

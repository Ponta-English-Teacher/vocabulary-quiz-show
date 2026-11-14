import type { VocabWord } from "@/data/vocab";
import { BANK_SOURCE } from "@/lib/studio/validation";
import { clampPlayCount } from "@/lib/playCount";
import type { BankWord } from "./types";
import { errorsOf, validateBankWord } from "./validate";

/**
 * From the independent Word Bank to the existing game. Pure functions: nothing here reads or writes any storage.
 * Gameplay itself (roles, hints, scoring) is unchanged: a bank word becomes an ordinary VocabWord with four hints.
 */

/** A game can have at most this many words (the class API accepts 1–50). */
export const MAX_BANK_GAME_WORDS = 50;
export const DEFAULT_BANK_GAME_WORDS = 10;

/**
 * The word as the game sees it. `accept` are the accepted English spellings (scoring unchanged). `ja` (approved Japanese ANSWERS, which
 * give half credit) is deliberately left empty: `giverJa` is a meaning for the Giver, not a list of answers the Taker may give.
 */
export function toVocabWord(w: BankWord): VocabWord {
  return {
    id: w.id,
    word: w.word,
    ...(w.accept.length ? { accept: [...w.accept] } : {}),
    partOfSpeech: w.partOfSpeech,
    category: w.category,
    cefr: w.cefr,
    meaning: w.meaning ?? "",
    example: w.example ?? "",
    hints: [...w.hints],
    ...(w.giverJa ? { giverJa: w.giverJa } : {}),
    source: BANK_SOURCE,
    sourceId: w.id,
  };
}

/** Fisher–Yates with an injectable random source (so tests are deterministic). */
function shuffle<T>(list: readonly T[], rng: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface Playable {
  words: BankWord[];
  /** Approved words left out because they no longer pass validation (should be none). */
  excluded: number;
}

/** Only APPROVED words, and only ones that still pass every error check. Anything else (draft, archived, damaged) is never played. */
export function playableFrom(words: readonly BankWord[]): Playable {
  const approved = words.filter((w) => w.status === "approved");
  const ok = approved.filter((w) => errorsOf(validateBankWord(w)).length === 0);
  return { words: ok, excluded: approved.length - ok.length };
}

export const levelsIn = (words: readonly BankWord[]): string[] => [...new Set(words.map((w) => w.cefr))].sort();
export const categoriesIn = (words: readonly BankWord[]): string[] => [...new Set(words.map((w) => w.category))].sort((a, b) => a.localeCompare(b));

export function filterPlayable(words: readonly BankWord[], f: { cefr: string; category: string }): BankWord[] {
  return words.filter((w) => (f.cefr === "all" || w.cefr === f.cefr) && (f.category === "all" || w.category === f.category));
}

export interface IndependentPick {
  words: VocabWord[];
  count: number;
  /** True when fewer words were available than requested. */
  short: boolean;
}

/** A random selection of the matching approved words, never the same word twice. */
export function pickIndependent(pool: readonly BankWord[], requested: number, rng: () => number = Math.random): IndependentPick {
  const seen = new Set<string>();
  const unique = pool.filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)));
  const n = unique.length ? clampPlayCount(requested, Math.min(MAX_BANK_GAME_WORDS, unique.length)) : 0;
  return { words: shuffle(unique, rng).slice(0, n).map(toVocabWord), count: n, short: requested > n };
}

/** A clear message for the teacher when the independent bank cannot supply a game. Never falls back to another bank. */
export function unavailableMessage(kind: "error" | "empty" | "nomatch", detail?: string): string {
  if (kind === "error") return `The independent Word Bank could not be loaded${detail ? `: ${detail}` : "."} No game was started, and the other bank was not used. Try again, or choose the Current Bank on purpose.`;
  if (kind === "empty") return "The independent Word Bank has no approved words yet. Approve some in the Word Bank first. No game was started, and the other bank was not used.";
  return "No approved words in the independent Word Bank match this level and category. Choose another, or All levels / All categories.";
}

export type IndependentLoad = { kind: "ready"; playable: Playable } | { kind: "error"; message: string };

/** Load the approved words through the (read-only) list request. On ANY failure the result is an error: no other bank is ever substituted. */
export async function loadIndependent(api: { list: (f: { status: "approved" }) => Promise<{ ok: true; data: { words: BankWord[] } } | { ok: false; message: string }> }): Promise<IndependentLoad> {
  const r = await api.list({ status: "approved" });
  if (!r.ok) return { kind: "error", message: unavailableMessage("error", r.message) };
  return { kind: "ready", playable: playableFrom(r.data.words) };
}

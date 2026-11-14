import { CEFR_LEVELS, PARTS_OF_SPEECH } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { isLetterOnlyHint, isVagueOpeningHint, leaksTarget } from "@/lib/studio/validation";
import { BANK_STATUSES, HINT_COUNT, type BankIssue, type BankWord } from "./types";

/** Hard limits are errors; comfort limits are warnings. Hints are SPOKEN aloud, so they should be short sentences. */
export const BANK_LIMITS = {
  word: 60,
  accept: 8,
  acceptItem: 60,
  category: 60,
  topic: 60,
  giverJa: 60,
  meaning: 300,
  example: 300,
  hintMax: 200,
  /** Comfortable spoken length, in words. */
  hintWordsMin: 4,
  hintWordsMax: 28,
} as const;

/** Two hints sharing at least this much of their content words are treated as repeats. */
export const HINT_REPEAT_OVERLAP = 0.7;

const PLACEHOLDER = /\b(todo|tbd|lorem|ipsum|fixme|xxx+)\b|\?\?\?|\[\s*(insert|placeholder)[^\]]*\]/i;
const MARKUP = /<\s*\/?\s*(script|iframe|style|img|a|div|span)\b|javascript:/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿]/;
const STOP = new Set(["the", "a", "an", "it", "is", "are", "you", "to", "of", "and", "in", "on", "at", "for", "with", "this", "that", "can", "or", "your", "when", "people"]);

const wordsOf = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const keyWords = (s: string) => new Set(normalize(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
function overlap(a: string, b: string): number {
  const x = keyWords(a);
  const y = keyWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

export type BankDraft = Pick<BankWord, "word" | "accept" | "partOfSpeech" | "category" | "cefr"> & { hints: readonly string[] } &
  Partial<Pick<BankWord, "topic" | "giverJa" | "meaning" | "example" | "status">>;

/** All content checks for one word. Errors block approval; warnings are for the teacher's judgement. */
export function validateBankWord(w: BankDraft): BankIssue[] {
  const out: BankIssue[] = [];
  const err = (code: string, field: BankIssue["field"], message: string, hintIndex?: number) => out.push({ severity: "error", code, field, message, ...(hintIndex === undefined ? {} : { hintIndex }) });
  const warn = (code: string, field: BankIssue["field"], message: string, hintIndex?: number) => out.push({ severity: "warning", code, field, message, ...(hintIndex === undefined ? {} : { hintIndex }) });
  const text = (v: unknown, field: BankIssue["field"], label: string, max: number, hintIndex?: number) => {
    if (typeof v !== "string") return;
    if (v.length > max) err("too_long", field, `${label} is longer than ${max} characters.`, hintIndex);
    if (PLACEHOLDER.test(v)) err("placeholder", field, `${label} looks like placeholder text.`, hintIndex);
    if (MARKUP.test(v)) err("markup", field, `${label} contains HTML or script-like text.`, hintIndex);
    if (CONTROL.test(v)) err("control_char", field, `${label} contains invisible control characters.`, hintIndex);
  };

  // Required fields
  if (!w.word?.trim()) err("missing", "word", "The target word is missing.");
  else text(w.word, "word", "The target word", BANK_LIMITS.word);
  if (!(PARTS_OF_SPEECH as readonly string[]).includes(w.partOfSpeech)) err("bad_pos", "partOfSpeech", "Part of speech must be noun, verb, adjective, adverb or phrase.");
  if (!(CEFR_LEVELS as readonly string[]).includes(w.cefr)) err("bad_cefr", "cefr", "CEFR level must be A1, A2, B1, B2, C1 or C2.");
  if (!w.category?.trim()) err("missing", "category", "The category is missing.");
  else text(w.category, "category", "The category", BANK_LIMITS.category);
  if (w.status !== undefined && !(BANK_STATUSES as readonly string[]).includes(w.status)) err("bad_status", "status", "Status must be draft, approved or archived.");

  // Accepted answers
  const accept = Array.isArray(w.accept) ? w.accept : [];
  if (accept.length > BANK_LIMITS.accept) err("too_many", "accept", `At most ${BANK_LIMITS.accept} accepted answers.`);
  const seen = new Set([normalize(w.word ?? "")]);
  accept.forEach((a, i) => {
    text(a, "accept", `Accepted answer ${i + 1}`, BANK_LIMITS.acceptItem);
    const n = normalize(a);
    if (!n) err("empty", "accept", `Accepted answer ${i + 1} is empty.`);
    else if (seen.has(n)) warn("duplicate_accept", "accept", `Accepted answer "${a}" repeats the target word or another accepted answer.`);
    else seen.add(n);
  });

  // Optional fields
  if (w.topic !== undefined) text(w.topic, "topic", "The topic", BANK_LIMITS.topic);
  if (w.meaning !== undefined) text(w.meaning, "meaning", "The meaning", BANK_LIMITS.meaning);
  if (w.example !== undefined) text(w.example, "example", "The example", BANK_LIMITS.example);
  if (w.giverJa?.trim()) {
    text(w.giverJa, "giverJa", "The Japanese meaning", BANK_LIMITS.giverJa);
    if (!JAPANESE.test(w.giverJa)) warn("giverja_not_japanese", "giverJa", "The Japanese meaning contains no Japanese characters.");
  }

  // Hints: exactly four, each a short spoken line
  const hints = Array.isArray(w.hints) ? w.hints : [];
  if (hints.length !== HINT_COUNT) {
    err("hint_count", "hints", `Exactly ${HINT_COUNT} hints are required (found ${hints.length}).`);
  }
  const target = { word: w.word ?? "", accept };
  const norm: (string | null)[] = [];
  hints.forEach((h, i) => {
    const label = `Hint ${i + 1}`;
    if (typeof h !== "string" || !h.trim()) {
      err("empty", "hints", `${label} is empty.`, i);
      norm.push(null);
      return;
    }
    text(h, "hints", label, BANK_LIMITS.hintMax, i);
    norm.push(normalize(h));
    if (w.word?.trim() && leaksTarget(target, h)) err("leak", "hints", `${label} contains the answer (or a form of it).`, i);
    if (isLetterOnlyHint(h)) err("letter_only", "hints", `${label} only gives a letter, not a real clue.`, i);
    const n = wordsOf(h).length;
    if (n < BANK_LIMITS.hintWordsMin) warn("too_short", "hints", `${label} is very short (${n} word${n === 1 ? "" : "s"}); a Giver needs something to say.`, i);
    else if (n > BANK_LIMITS.hintWordsMax) warn("too_long_spoken", "hints", `${label} is long to say aloud (${n} words).`, i);
  });
  if (typeof hints[0] === "string" && hints[0].trim()) {
    if (isVagueOpeningHint(hints[0])) warn("vague_opening", "hints", "Hint 1 is only a label; set a scene the Giver can talk about.", 0);
    if (/\d/.test(hints[0])) warn("numeric_opening", "hints", "Hint 1 contains a number or date; an opening hint is easier to speak if it describes a situation.", 0);
  }

  // Repeats between hints
  for (let i = 0; i < hints.length; i++) {
    for (let j = i + 1; j < hints.length; j++) {
      if (norm[i] && norm[j] && norm[i] === norm[j]) err("repeated_hint", "hints", `Hint ${j + 1} repeats hint ${i + 1}.`, j);
      else if (typeof hints[i] === "string" && typeof hints[j] === "string" && overlap(hints[i], hints[j]) >= HINT_REPEAT_OVERLAP) {
        warn("similar_hints", "hints", `Hint ${j + 1} is very similar to hint ${i + 1}; each hint should add something new.`, j);
      }
    }
  }
  return out;
}

export const errorsOf = (issues: readonly BankIssue[]) => issues.filter((i) => i.severity === "error");
export const warningsOf = (issues: readonly BankIssue[]) => issues.filter((i) => i.severity === "warning");

/** Duplicate detection key: the normalised target word. */
export const wordKey = (w: Pick<BankWord, "word">) => normalize(w.word);

/** Every normalised form that counts as this word: the target plus its accepted answers. */
export const formsOf = (w: Pick<BankWord, "word" | "accept">): string[] => [w.word, ...(w.accept ?? [])].map(normalize).filter(Boolean);

type Comparable = Pick<BankWord, "word"> & { cefr?: string; hints?: readonly string[] };

/** Identity of a record: target word + CEFR level + the four hints in order (case, punctuation and spacing ignored). Accepted answers, meaning and example do not matter. */
export const identityKey = (w: Comparable): string => [normalize(w.word), (w.cefr ?? "").toUpperCase(), ...(w.hints ?? []).map(normalize)].join("\u0001");

/** Genuinely identical: same word, same level, same hint sequence. */
export const isIdentical = (a: Comparable, b: Comparable): boolean => !!a.cefr && !!b.cefr && !!a.hints?.length && identityKey(a) === identityKey(b);

export type SameWordKind = "identical" | "different_level" | "different_hints";

/** How `w` relates to another record with the same target word. Identical is rejected; the others need a teacher's decision. */
export function sameWordKind(w: Comparable, other: Comparable): SameWordKind | null {
  if (normalize(w.word) !== normalize(other.word) || !normalize(w.word)) return null;
  if (isIdentical(w, other)) return "identical";
  return (w.cefr ?? "").toUpperCase() !== (other.cefr ?? "").toUpperCase() ? "different_level" : "different_hints";
}

export const SAME_WORD_NOTE: Record<SameWordKind, string> = {
  identical: "An identical record (same word, level and hints) already exists.",
  different_level: "The same word already exists at a different CEFR level. Check it is intended.",
  different_hints: "The same word already exists at this level with different hints. Check it is intended.",
};

/** Same-word groups among non-archived words, each labelled by what kind of repeat it is (identical repeats are the only ones that are errors). */
export function findDuplicateWords(words: readonly (Comparable & Pick<BankWord, "id" | "status">)[]): Array<{ word: string; ids: string[]; kind: SameWordKind }> {
  const groups = new Map<string, (Comparable & Pick<BankWord, "id" | "status">)[]>();
  for (const w of words) {
    if (w.status === "archived") continue;
    const k = normalize(w.word);
    if (k) groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  const out: Array<{ word: string; ids: string[]; kind: SameWordKind }> = [];
  for (const [word, list] of groups) {
    if (list.length < 2) continue;
    const kinds = new Set<SameWordKind>();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) kinds.add(sameWordKind(list[i], list[j])!);
    out.push({ word, ids: list.map((w) => w.id), kind: kinds.has("identical") ? "identical" : kinds.has("different_level") ? "different_level" : "different_hints" });
  }
  return out;
}

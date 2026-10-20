import { CEFR_LEVELS, PARTS_OF_SPEECH, type CefrLevel, type GiverInfo, type PartOfSpeech, type VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { normalizeJa } from "@/lib/japanese";
import { newId } from "./ids";

/**
 * Validation for vocabulary items — used for AI output, saved data and live teacher editing.
 *
 *  coerceWord        shape/normalisation only (loose input → VocabWord, or errors)
 *  validateWord      content rules (hint leaks, blanks, …) → issues with severity
 *  parseGeneratedWords  coerce + validate + de-duplicate a whole AI list
 */

export const LIMITS = {
  word: 60, category: 60, meaning: 300, example: 300, hint: 200, accept: 8,
  /** Giver notes: each line is meant to be said aloud, so keep it short. */
  giverLine: 200, phrase: 100, phrases: 4,
  /** Approved Japanese equivalents. */
  ja: 8, jaItem: 40,
} as const;

export interface WordIssue {
  /** Machine-readable reason, where one matters (e.g. AI output with letter-only hints is rejected). */
  code?: "letter-only" | "too-short" | "vague-opening" | "no-japanese" | "no-giver-info";
  field: "word" | "accept" | "partOfSpeech" | "cefr" | "category" | "meaning" | "example" | "hints" | "giverInfo" | "ja";
  hintIndex?: number;
  severity: "error" | "warning";
  message: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

const POS_ALIASES: Record<string, PartOfSpeech> = {
  noun: "noun", n: "noun",
  verb: "verb", v: "verb",
  adjective: "adjective", adj: "adjective",
  adverb: "adverb", adv: "adverb",
  phrase: "phrase", expression: "phrase", idiom: "phrase", "idiomatic expression": "phrase",
  "phrasal verb": "phrase", collocation: "phrase", "fixed expression": "phrase",
};

export function normalizePartOfSpeech(v: unknown): PartOfSpeech | null {
  return POS_ALIASES[str(v).toLowerCase()] ?? null;
}

export function normalizeCefr(v: unknown): CefrLevel | null {
  const up = str(v).toUpperCase();
  return (CEFR_LEVELS as readonly string[]).includes(up) ? (up as CefrLevel) : null;
}

/**
 * Does `text` give away the target? Catches the word, its accepted variants,
 * plurals/inflections (shared stem), and — for phrases — the whole phrase or any long content word.
 */
export function leaksTarget(target: Pick<VocabWord, "word" | "accept">, text: string): boolean {
  const body = normalize(text);
  if (!body) return false;
  const tokens = body.split(" ");
  const primary = normalize(target.word);
  const forms = [target.word, ...(target.accept ?? [])].map(normalize).filter(Boolean);

  for (const form of forms) {
    if (` ${body} `.includes(` ${form} `)) return true;
    const parts = form.split(" ");
    // Multi-word ACCEPTED variants (e.g. "kiwi fruit") only leak as a whole phrase;
    // their individual words are too generic to police.
    if (parts.length > 1 && form !== primary) continue;
    const checks = parts.length === 1 ? parts : parts.filter((p) => p.length >= 5);
    for (const t of checks) {
      for (const tok of tokens) {
        if (t.length <= 4) {
          if (tok === t || tok === `${t}s` || tok === `${t}es`) return true;
        } else if (tok.startsWith(t.slice(0, Math.max(4, t.length - 2)))) {
          return true;
        }
      }
    }
  }
  return false;
}

/** A hint that only gives the first letter (or word shape) and no real clue. */
const LETTER_ONLY: RegExp[] = [
  /^(?:it|the word|the first (?:letter|word)|its first letter|first letter)\s*(?:is|starts|begins)?\s*(?:with)?\s*(?:the letter\s*)?["'“”‘’]?[a-z]["'“”‘’]?[.!]?$/i,
  /^(?:it )?(?:has|is) (?:two|three|four|\d+) words?,? (?:and )?(?:the )?first (?:word )?(?:starts|begins) with ["'“”‘’]?[a-z]["'“”‘’]?[.!]?$/i,
];
export const isLetterOnlyHint = (h: string): boolean => LETTER_ONLY.some((r) => r.test(h.trim()));
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The OPENING hint is shown to both players automatically, so it must set a real scene (who, when, where) —
 * not a label such as "It is a kitchen tool." These patterns catch the generic ones only.
 */
const VAGUE_OPENING: RegExp[] = [
  /^(?:it|this|that)(?:'s| is| are)? (?:a |an |the )?(?:[a-z]+ )?(?:tool|object|item|thing|word|utensil|device|noun|verb|adjective|action|feeling|expression)s?\.?$/i,
  /^(?:it|this)(?:'s| is)? (?:used|found|seen|kept) (?:in|at|on) (?:the |a |your )?(?:kitchen|house|home|school|office|shop|store|bathroom|garden)\.?$/i,
  /^(?:it|this)(?:'s| is)? used for (?:cooking|cleaning|eating|working|studying|learning|travel|shopping)\.?$/i,
  /^it belongs to the topic\b/i,
];
export const isVagueOpeningHint = (h: string): boolean => VAGUE_OPENING.some((r) => r.test(h.trim()));

export function validateWord(w: VocabWord): WordIssue[] {
  const issues: WordIssue[] = [];
  const err = (field: WordIssue["field"], message: string, hintIndex?: number) =>
    issues.push({ field, message, severity: "error", hintIndex });
  const warn = (field: WordIssue["field"], message: string, hintIndex?: number, code?: WordIssue["code"]) =>
    issues.push({ field, message, severity: "warning", hintIndex, code });

  if (!w.word.trim()) err("word", "The target word is empty.");
  if (w.word.length > LIMITS.word) err("word", `The word is longer than ${LIMITS.word} characters.`);
  if (!(PARTS_OF_SPEECH as readonly string[]).includes(w.partOfSpeech)) err("partOfSpeech", "Part of speech is not valid.");
  if (!(CEFR_LEVELS as readonly string[]).includes(w.cefr)) err("cefr", "CEFR level is not valid.");

  if (!w.category.trim()) err("category", "Category is empty.");
  else if (leaksTarget(w, w.category)) err("category", "The category gives away the word (the Taker can see it).");

  if (!w.meaning.trim()) err("meaning", "Definition is empty.");
  else if (leaksTarget(w, w.meaning)) warn("meaning", "The definition contains the target word — the Giver would have to avoid reading it.");
  if (w.meaning.length > LIMITS.meaning) err("meaning", `Definition is longer than ${LIMITS.meaning} characters.`);

  if (!w.example.trim()) err("example", "Example sentence is empty.");
  if (w.example.length > LIMITS.example) err("example", `Example is longer than ${LIMITS.example} characters.`);

  if (w.hints.length !== 3) err("hints", "Exactly three hints are required.");
  w.hints.forEach((h, i) => {
    if (!h.trim()) err("hints", `Hint ${i + 1} is empty.`, i);
    else if (leaksTarget(w, h)) err("hints", `Hint ${i + 1} gives away the word.`, i);
    if (h.length > LIMITS.hint) err("hints", `Hint ${i + 1} is longer than ${LIMITS.hint} characters.`, i);
  });
  w.hints.forEach((h, i) => {
    if (!h.trim()) return;
    if (isLetterOnlyHint(h)) {
      warn("hints", `Hint ${i + 1} only gives the first letter — add a real clue (what it does, where you meet it, a sentence with a blank).`, i, "letter-only");
    } else if (wordCount(h) < 4) {
      warn("hints", `Hint ${i + 1} is very short — a fuller clue helps the Giver.`, i, "too-short");
    }
  });
  if (w.hints[0]?.trim() && isVagueOpeningHint(w.hints[0])) {
    warn("hints", "Hint 1 is shown to both players automatically for free — make it a real situation (who, when, where), not just a label like “it is a kitchen tool”.", 0, "vague-opening");
  }
  if (new Set(w.hints.map(normalize)).size < w.hints.filter((h) => h.trim()).length) warn("hints", "Two hints are identical.");

  // Giver notes: optional, but they must be speakable and must not contain the word the Giver may not say.
  const info = w.giverInfo;
  if (!info || (!info.looks && !info.use && !(info.phrases ?? []).length)) {
    warn("giverInfo", "No Giver notes yet — the Giver will see only the definition and hints.", undefined, "no-giver-info");
  } else {
    const lines: [string, string | undefined][] = [["Appearance", info.looks], ["Use", info.use], ...(info.phrases ?? []).map((p, i): [string, string] => [`Useful phrase ${i + 1}`, p])];
    for (const [label, text] of lines) {
      if (!text) continue;
      if (leaksTarget(w, text)) warn("giverInfo", `${label} contains the target word — the Giver is not allowed to say it.`);
      if (text.length > (label.startsWith("Useful") ? LIMITS.phrase : LIMITS.giverLine)) err("giverInfo", `${label} is too long to say aloud.`);
    }
    if ((info.phrases ?? []).length > LIMITS.phrases) err("giverInfo", `At most ${LIMITS.phrases} useful phrases.`);
  }

  // Japanese equivalents drive Japanese answers. No approved entry = no Japanese credit for this word.
  const ja = (w.ja ?? []).filter((j) => j.trim());
  if (!ja.length) {
    warn("ja", "No Japanese answer — Taker can't earn Japanese (half) credit for this word.", undefined, "no-japanese");
  } else {
    if (ja.length > LIMITS.ja) err("ja", `At most ${LIMITS.ja} Japanese answers.`);
    if (ja.some((j) => j.length > LIMITS.jaItem)) err("ja", `Each Japanese answer must be ${LIMITS.jaItem} characters or fewer.`);
    if (new Set(ja.map(normalizeJa)).size < ja.length) warn("ja", "Two Japanese answers are the same once kana/spacing differences are ignored.");
  }

  if ((w.accept ?? []).length > LIMITS.accept) err("accept", `At most ${LIMITS.accept} alternative answers.`);
  return issues;
}

export const hasErrors = (issues: WordIssue[]) => issues.some((i) => i.severity === "error");

export type CoerceResult = { word: VocabWord } | { errors: string[] };

export function coerceGiverInfo(raw: unknown): GiverInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const looks = str(r.looks).slice(0, LIMITS.giverLine);
  const use = str(r.use).slice(0, LIMITS.giverLine);
  const phrases = (Array.isArray(r.phrases) ? r.phrases : []).map((p) => str(p).slice(0, LIMITS.phrase)).filter(Boolean).slice(0, LIMITS.phrases);
  if (!looks && !use && !phrases.length) return undefined;
  return { ...(looks ? { looks } : {}), ...(use ? { use } : {}), ...(phrases.length ? { phrases } : {}) };
}

/** Japanese equivalents: a list (or one comma-separated string), de-duplicated once kana/spacing differences are ignored. */
export function coerceJa(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,、，;；\/／]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const s = str(item).slice(0, LIMITS.jaItem);
    const key = normalizeJa(s);
    if (s && key && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out.slice(0, LIMITS.ja);
}

/** Turn loosely-typed data (from an AI or storage) into a VocabWord. Does not apply content rules. */
export function coerceWord(raw: unknown, opts: { id?: string } = {}): CoerceResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["not an object"] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  const word = str(r.word);
  if (!word) errors.push("missing word");
  const pos = normalizePartOfSpeech(r.partOfSpeech ?? r.pos);
  if (!pos) errors.push("invalid partOfSpeech");
  const cefr = normalizeCefr(r.cefr ?? r.level);
  if (!cefr) errors.push("invalid cefr level");
  const category = str(r.category);
  if (!category) errors.push("missing category");
  const meaning = str(r.meaning ?? r.definition);
  if (!meaning) errors.push("missing definition");
  const example = str(r.example);
  if (!example) errors.push("missing example");

  const hintsRaw = Array.isArray(r.hints) ? r.hints.map(str).filter(Boolean) : [];
  if (hintsRaw.length < 3) errors.push("needs three hints");

  const acceptRaw = Array.isArray(r.accept) ? r.accept : Array.isArray(r.acceptedAnswers) ? r.acceptedAnswers : [];
  const seen = new Set([normalize(word)]);
  const accept: string[] = [];
  for (const a of acceptRaw) {
    const s = str(a);
    const n = normalize(s);
    if (s && n && !seen.has(n)) {
      seen.add(n);
      accept.push(s);
    }
  }

  // Optional fields — sets saved before they existed simply don't have them. The AI may send them flat or nested.
  const giverInfo = coerceGiverInfo(r.giverInfo ?? { looks: r.looks, use: r.use, phrases: r.phrases });
  const ja = coerceJa(r.ja ?? r.japanese);

  if (errors.length || !pos || !cefr) return { errors };
  return {
    word: {
      id: opts.id ?? newId("w"),
      word,
      ...(accept.length ? { accept: accept.slice(0, LIMITS.accept) } : {}),
      partOfSpeech: pos,
      category,
      cefr,
      meaning,
      example,
      hints: hintsRaw.slice(0, 3),
      ...(giverInfo ? { giverInfo } : {}),
      ...(ja.length ? { ja } : {}),
    },
  };
}

/**
 * What kind of word does the teacher's topic ask for? Only decided when the wording is clear:
 *   "kitchen tools" → objects (nouns, incl. noun compounds)   "cooking actions" → verbs (incl. phrasal verbs)
 *   "expressions" → phrases.   Anything ambiguous or unrecognised → null (no enforcement).
 */
export function expectedPartsOfSpeech(topic: string, wordType = ""): { allowed: PartOfSpeech[]; label: string } | null {
  const t = `${topic} ${wordType}`.toLowerCase();
  const objects = /\b(tools?|utensils?|objects?|items?|equipment|appliances?|gadgets?|furniture|clothes|clothing|vehicles?|things)\b/.test(t);
  const actions = /\b(actions?|verbs?|movements?|gestures?)\b/.test(t);
  const expressions = /\b(expressions?|phrases?|idioms?|collocations?)\b/.test(t);
  const hits = [objects, actions, expressions].filter(Boolean).length;
  if (hits !== 1) return null;
  if (objects) return { allowed: ["noun", "phrase"], label: "objects and utensils (nouns)" };
  if (actions) return { allowed: ["verb", "phrase"], label: "actions (verbs)" };
  return { allowed: ["phrase"], label: "expressions" };
}

export interface ParsedWords {
  words: VocabWord[];
  /** Human-readable reasons why items were rejected. */
  issues: string[];
}

/** Validate a whole AI list: shape, content rules, duplicates (also against `exclude`). */
export function parseGeneratedWords(
  raw: unknown,
  ctx: { exclude?: string[]; max?: number; topic?: string; wordType?: string } = {},
): ParsedWords {
  const expected = ctx.topic ? expectedPartsOfSpeech(ctx.topic, ctx.wordType) : null;
  const issues: string[] = [];
  if (!Array.isArray(raw)) return { words: [], issues: ["The AI did not return a list of words."] };

  const taken = new Set((ctx.exclude ?? []).map(normalize));
  const words: VocabWord[] = [];
  raw.forEach((item, i) => {
    const label = `Item ${i + 1}`;
    const coerced = coerceWord(item);
    if ("errors" in coerced) {
      issues.push(`${label}: ${coerced.errors.join(", ")}.`);
      return;
    }
    const w = coerced.word;
    // AI output must be clean: errors AND letter-only hints are rejected (teachers may still keep one by hand).
    const problems = validateWord(w).filter((p) => p.severity === "error" || p.code === "letter-only" || p.code === "vague-opening");
    if (problems.length) {
      issues.push(`${label} (“${w.word}”): ${problems.map((p) => p.message).join(" ")}`);
      return;
    }
    // Topic accuracy: "kitchen tools" must not turn into cooking verbs (and vice versa).
    if (expected && !expected.allowed.includes(w.partOfSpeech)) {
      issues.push(`${label} (“${w.word}”): this is a ${w.partOfSpeech}, but the requested topic “${ctx.topic}” asks for ${expected.label}.`);
      return;
    }
    const forms = [w.word, ...(w.accept ?? [])].map(normalize);
    if (forms.some((f) => taken.has(f))) {
      issues.push(`${label} (“${w.word}”): duplicate word.`);
      return;
    }
    forms.forEach((f) => taken.add(f));
    if (ctx.max === undefined || words.length < ctx.max) words.push(w);
  });
  return { words, issues };
}

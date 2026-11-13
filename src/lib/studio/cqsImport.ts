import { CEFR_LEVELS, type CefrLevel, type VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { newId } from "./ids";
import { IMPORT_SOURCE, isVagueOpeningHint, isLetterOnlyHint, leaksTarget, normalizeCefr, validateWord, LIMITS } from "./validation";

/**
 * One-way, offline conversion of a Classroom Quiz Show question-bank export into Vocabulary Quiz Show words.
 *
 * Nothing here touches a network, a database, or AI, and nothing is invented: Classroom Quiz Show has no definitions, example sentences
 * or Japanese, so imported words simply have none (see `source` on VocabWord). What is converted:
 *
 *   answer      → target word (a leading "a / an / the" is dropped; the full answer stays accepted)
 *   cefrLevel   → cefr           categoryName → category
 *   chunks 1–4  → hints. Chunk 4 is the easiest and chunk 1 the hardest, so the clues are tried easiest first (4, 3, 2, 1). A clue that
 *                 contains the word is left out. The first three remaining clues become the three hints (hint 1 is the free opening hint).
 *
 * Every question ends up "ready" (looks fine), "flagged" (probably unsuitable for a spoken explain-and-guess game; the teacher decides)
 * or "skipped" (cannot be imported: not approved, malformed, duplicate, or fewer than three clean clues).
 */
export const CQS_FORMAT = "classroom-quiz-show/questions";
export const CQS_VERSION = 1;

export interface CqsQuestion {
  id: string;
  cefrLevel: string;
  categoryId?: string;
  categoryName?: string;
  prompt?: string;
  chunks: string[];
  choices: string[];
  correctIndex: number;
  answer?: string;
  status: string;
}

export type ParsedExport = { ok: true; questions: unknown[]; exportedAt: string; declaredCount: number } | { ok: false; error: string };

/** Read the text of an export file. Only the known format and version are accepted. */
export function parseCqsExport(text: string): ParsedExport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }
  const d = data as { format?: unknown; version?: unknown; questions?: unknown; exportedAt?: unknown; count?: unknown } | null;
  if (!d || typeof d !== "object" || d.format !== CQS_FORMAT) return { ok: false, error: `This is not a Classroom Quiz Show question export (expected format “${CQS_FORMAT}”).` };
  if (d.version !== CQS_VERSION) return { ok: false, error: `Unsupported export version ${String(d.version)}. Only version ${CQS_VERSION} can be imported.` };
  if (!Array.isArray(d.questions)) return { ok: false, error: "The export has no list of questions." };
  return { ok: true, questions: d.questions, exportedAt: typeof d.exportedAt === "string" ? d.exportedAt : "", declaredCount: typeof d.count === "number" ? d.count : d.questions.length };
}

export type ImportStatus = "ready" | "flagged" | "skipped";

export interface ImportItem {
  sourceId: string;
  status: ImportStatus;
  /** Shown to the teacher: the target word (or the raw answer when no word could be made). */
  label: string;
  cefr: string;
  category: string;
  prompt: string;
  /** Why it is flagged or skipped. */
  reasons: string[];
  /** Things the teacher should know that do not block anything (e.g. a clue was left out). */
  notes: string[];
  /** Present unless skipped. */
  word?: VocabWord;
}

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const ARTICLE = /^(?:a|an|the)\s+/i;

/** "a cat" → { word: "cat", accept: ["a cat"] }; "The Beatles" → { word: "Beatles", accept: ["The Beatles"] }. */
export function targetFromAnswer(answer: string): { word: string; accept: string[] } {
  const a = str(answer);
  const bare = a.replace(ARTICLE, "").trim();
  if (!bare) return { word: a, accept: [] };
  return { word: bare, accept: bare !== a ? [a] : [] };
}

const PERSON = /^who\b|\bwhich (?:person|writer|author|painter|composer|scientist|musician|athlete|leader|inventor|explorer|character)\b/i;
const TITLE_OR_ABSTRACT = /\bwhich (?:film|movie|book|novel|band|painting|artwork|art|play|work|document|story|fairy tale|film series|event|race|competition|period|historical|art movement|art form|form of writing|idea|process|kind of music)\b/i;
const EASY_PROPER = /\b(?:month|day of the week|day|season|country|planet|ocean|continent|time of day|colou?r)\b/i;
const NEEDS_PICTURE = /\b(?:picture|image|photo|photograph|shown|look at)\b|\bthis looks\b/i;
const VAGUE_PROMPT = /^which word is this\b/i;

/** Flags that say "probably not suitable for a spoken explain-and-guess vocabulary game". The teacher can still include these. */
export function suitabilityFlags(args: { word: string; accept: string[]; prompt: string; hints: string[] }): string[] {
  const { word, prompt, hints } = args;
  const flags: string[] = [];
  if (/[^\x00-\x7F]|\d/.test(word)) flags.push("The answer has accents, symbols or digits, which are hard to say and to type from hearing.");
  if (word.split(/\s+/).length > 3) flags.push("The answer is longer than three words.");
  if (word.length < 3) flags.push("The answer is very short.");
  if (PERSON.test(prompt)) flags.push("It asks for a person (names are hard to explain and to spell).");
  else if (TITLE_OR_ABSTRACT.test(prompt)) flags.push("It asks for a title, event or abstract idea rather than a vocabulary word.");
  else if (/^[A-Z]/.test(word) && !EASY_PROPER.test(prompt)) flags.push("The answer is a proper name (place, title or brand).");
  if (VAGUE_PROMPT.test(prompt)) flags.push("The part of speech is unknown (assumed to be a noun).");
  if (hints.some((h) => NEEDS_PICTURE.test(h))) flags.push("A clue seems to depend on a picture.");
  return flags;
}

/** Convert one question. `seen` holds the normalised target forms already taken in this file, so a repeated word is skipped. */
export function convertQuestion(raw: unknown, seen: Set<string> = new Set()): ImportItem {
  const q = (raw && typeof raw === "object" ? raw : {}) as Partial<CqsQuestion>;
  const sourceId = str(q.id);
  const prompt = str(q.prompt);
  const cefrN = normalizeCefr(q.cefrLevel);
  const category = str(q.categoryName) || str(q.categoryId);
  const choices = Array.isArray(q.choices) ? q.choices : [];
  const answerRaw = str(typeof q.correctIndex === "number" ? choices[q.correctIndex] : "") || str(q.answer);
  const base = { sourceId, label: answerRaw || sourceId || "(no answer)", cefr: cefrN ?? str(q.cefrLevel), category, prompt, notes: [] as string[] };
  const skip = (...reasons: string[]): ImportItem => ({ ...base, status: "skipped", reasons });

  if (q.status !== "approved") return skip(`Not imported: its status in Classroom Quiz Show is “${str(q.status) || "unknown"}”, not approved.`);
  if (!sourceId) return skip("The question has no id.");
  if (!cefrN || !(CEFR_LEVELS as readonly string[]).includes(cefrN)) return skip("The CEFR level is missing or not recognised.");
  if (!category) return skip("The category is missing.");
  if (!answerRaw) return skip("The correct answer could not be found.");
  if (!Array.isArray(q.chunks) || q.chunks.length !== 4 || q.chunks.some((c) => typeof c !== "string")) return skip("The question does not have four clues.");

  const { word, accept } = targetFromAnswer(answerRaw);
  if (!word || word.length > LIMITS.word) return skip("The answer is empty or too long to use as a word.");
  const forms = [word, ...accept].map(normalize).filter(Boolean);
  const dupe = forms.find((f) => seen.has(f));
  if (dupe) return skip(`Another question in this file already uses “${word}”.`);

  // Clues, easiest first (chunk 4 → chunk 1). A clue that contains the word, or is blank or too long, is left out.
  const target = { word, accept };
  const notes: string[] = [];
  const usable: string[] = [];
  for (let i = 3; i >= 0; i--) {
    const clue = str(q.chunks[i]);
    if (!clue) notes.push(`Clue ${i + 1} is empty and was left out.`);
    else if (leaksTarget(target, clue)) notes.push(`Clue ${i + 1} was left out because it contains the word.`);
    else if (clue.length > LIMITS.hint) notes.push(`Clue ${i + 1} was left out because it is too long.`);
    else usable.push(clue);
  }
  if (usable.length < 3) return { ...skip(`Only ${usable.length} usable clue${usable.length === 1 ? "" : "s"} (three are needed). ${notes.join(" ")}`.trim()), notes };
  const hints = usable.slice(0, 3);
  if (usable.length > 3) notes.push("The hardest clue was not used (a word has three hints).");

  const flags = suitabilityFlags({ word, accept, prompt, hints });
  const pos = /\s/.test(word) ? "phrase" : "noun";
  const vocab: VocabWord = {
    id: newId("w"),
    word,
    ...(accept.length ? { accept } : {}),
    partOfSpeech: pos,
    category,
    cefr: cefrN as CefrLevel,
    meaning: "",
    example: "",
    hints,
    source: IMPORT_SOURCE,
    sourceId,
  };

  // The ordinary word checks (a hint or the category giving the word away is an error; a vague opening hint needs correcting).
  const problems = validateWord(vocab);
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length) return { ...skip(...errors.map((e) => e.message)), notes };
  for (const p of problems) {
    if (p.field === "hints" && (p.code === "vague-opening" || p.code === "letter-only")) flags.push(`Opening hint: ${p.message}`);
  }
  if (isVagueOpeningHint(hints[0]) || isLetterOnlyHint(hints[0])) { /* already reported above */ }

  forms.forEach((f) => seen.add(f));
  return { ...base, label: word, status: flags.length ? "flagged" : "ready", reasons: flags, notes, word: vocab };
}

export interface ImportReport {
  items: ImportItem[];
  counts: { total: number; ready: number; flagged: number; skipped: number; notApproved: number };
}

/** Convert a whole export. `alreadyImported` are source ids found in saved activities: those are skipped, so importing twice never duplicates. */
export function convertExport(questions: readonly unknown[], alreadyImported: ReadonlySet<string> = new Set()): ImportReport {
  const seen = new Set<string>();
  const items = questions.map((q): ImportItem => {
    const id = q && typeof q === "object" ? str((q as { id?: unknown }).id) : "";
    if (id && alreadyImported.has(id)) {
      const a = convertQuestion(q, new Set());
      return { ...a, status: "skipped", word: undefined, reasons: ["Already imported earlier (it is in one of your saved sets)."] };
    }
    return convertQuestion(q, seen);
  });
  const count = (s: ImportStatus) => items.filter((i) => i.status === s).length;
  const notApproved = items.filter((i) => i.status === "skipped" && i.reasons[0]?.startsWith("Not imported")).length;
  return { items, counts: { total: items.length, ready: count("ready"), flagged: count("flagged"), skipped: count("skipped"), notApproved } };
}

/** Source ids of every imported word in the given saved activities. */
export function importedSourceIds(activities: readonly { sets: readonly { words: readonly { sourceId?: string }[] }[] }[]): Set<string> {
  const ids = new Set<string>();
  for (const a of activities) for (const s of a.sets) for (const w of s.words) if (w.sourceId) ids.add(w.sourceId);
  return ids;
}

export const SET_WORD_LIMIT = 10;

/** Group chosen words by level and category (levels in order), at most ten words per set. Each group gets a descriptive title. */
export function groupIntoSets(words: readonly VocabWord[]): { title: string; words: VocabWord[] }[] {
  const order = (c: string) => (CEFR_LEVELS as readonly string[]).indexOf(c);
  const sorted = [...words].sort((a, b) => order(a.cefr) - order(b.cefr) || a.category.localeCompare(b.category));
  const groups = new Map<string, VocabWord[]>();
  for (const w of sorted) {
    const key = `${w.cefr} ${w.category}`;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  const sets: { title: string; words: VocabWord[] }[] = [];
  for (const [key, list] of groups) {
    const parts = Math.ceil(list.length / SET_WORD_LIMIT);
    for (let i = 0; i < parts; i++) sets.push({ title: parts > 1 ? `${key} (${i + 1})` : key, words: list.slice(i * SET_WORD_LIMIT, (i + 1) * SET_WORD_LIMIT) });
  }
  return sets;
}

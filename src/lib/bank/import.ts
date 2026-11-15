import { CEFR_LEVELS, type CefrLevel, type PartOfSpeech } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { newId } from "@/lib/studio/ids";
import { normalizeCefr, normalizePartOfSpeech } from "@/lib/studio/validation";
import { BANK_FORMAT, HINT_COUNT, type BankIssue, type BankWord } from "./types";
import { SAME_WORD_NOTE, errorsOf, formsOf, sameWordKind, validateBankWord, warningsOf } from "./validate";

/**
 * Parsing and preview for VQS word files (JSON or CSV). Pure: nothing is stored, sent or changed here.
 * Adapted from Classroom Quiz Show's bulk importer: every record gets a status and reasons BEFORE anything is imported,
 * and imported words always arrive as DRAFTS (a teacher approves explicitly).
 */
export type ImportFormat = "json" | "csv";
export const MAX_IMPORT = 1000;

export type RecordStatus = "valid" | "warning" | "review" | "duplicate" | "invalid";

export interface ImportCandidate {
  word: string;
  accept: string[];
  partOfSpeech: PartOfSpeech;
  category: string;
  cefr: CefrLevel;
  topic?: string;
  giverJa?: string;
  openingQuestion?: string;
  meaning?: string;
  example?: string;
  hints: string[];
  /** Where the word came from. Only "classroom-quiz-show" is kept from a file; anything else is "file". */
  source: BankWord["source"];
  sourceId?: string;
}

export interface AnalyzedRecord {
  /** 1-based position in the file. */
  index: number;
  status: RecordStatus;
  candidate: ImportCandidate | null;
  errors: BankIssue[];
  warnings: BankIssue[];
  /** Why a record is a duplicate or needs review. */
  note?: string;
  /** valid / warning only. */
  importable: boolean;
  /** True for "review" records: they are imported only if the teacher chooses to keep them (see draftsFromAnalysis). */
  needsDecision?: boolean;
}

export interface ImportAnalysis {
  fileErrors: string[];
  records: AnalyzedRecord[];
  counts: { total: number; valid: number; warning: number; review: number; duplicate: number; invalid: number; importable: number };
}

// ------------------------------------------------------------------ parsing

export function detectFormat(text: string, filename?: string): ImportFormat {
  const name = filename?.toLowerCase() ?? "";
  const first = text.replace(/^﻿/, "").trimStart()[0];
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv";
  return first === "[" || first === "{" ? "json" : "csv";
}

function detectDelimiter(text: string): string {
  let quoted = false;
  const counts: Record<string, number> = { ",": 0, "\t": 0, ";": 0 };
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "\n") break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/** Minimal RFC 4180 CSV reader (quotes, doubled quotes, CRLF, BOM). */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const delim = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (text[i + 1] === "\n") i++; endRow(); }
    else field += ch;
  }
  if (quoted) throw new Error("A quoted CSV field is never closed. Check for a missing closing quote.");
  if (field !== "" || row.length) endRow();
  return rows;
}

type Raw = Record<string, unknown>;
/** "Hint 1", "hint_1" and "hint1" all match. */
const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, "");
const normalizeKeys = (o: Raw): Raw => Object.fromEntries(Object.entries(o).map(([k, v]) => [key(k), v]));

const REQUIRED_CSV: string[][] = [["word", "target", "answer"], ["partofspeech", "pos"], ["category"], ["level", "cefr", "cefrlevel"], ["hint1"], ["hint2"], ["hint3"], ["hint4"]];

export function parseRecords(text: string, format: ImportFormat): { records: Raw[]; fileErrors: string[] } {
  if (!text.trim()) return { records: [], fileErrors: ["The file is empty."] };
  if (format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
      return { records: [], fileErrors: [`This is not valid JSON: ${(e as Error).message}`] };
    }
    const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Raw) : null;
    if (obj && typeof obj.format === "string" && obj.format !== BANK_FORMAT) {
      return { records: [], fileErrors: [`This file is "${obj.format}", not a Vocabulary Quiz Show word file ("${BANK_FORMAT}").`] };
    }
    const list = Array.isArray(data) ? data : obj && Array.isArray(obj.words) ? obj.words : null;
    if (!list) return { records: [], fileErrors: ['The JSON must be a list of words, or an object with a "words" list.'] };
    return { records: list.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? normalizeKeys(r as Raw) : { __notObject: true })), fileErrors: [] };
  }
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (e) {
    return { records: [], fileErrors: [(e as Error).message] };
  }
  if (rows.length < 2) return { records: [], fileErrors: ["The CSV needs a header row and at least one word."] };
  const header = rows[0].map(key);
  const missing = REQUIRED_CSV.filter((alts) => !alts.some((a) => header.includes(a))).map((a) => a[0]);
  if (missing.length) return { records: [], fileErrors: [`The CSV header is missing these columns: ${missing.join(", ")}. Download the template to see the expected columns.`] };
  return {
    records: rows.slice(1).map((cells) => {
      const o: Raw = {};
      header.forEach((h, i) => { if (h) o[h] = cells[i] ?? ""; });
      return o;
    }),
    fileErrors: [],
  };
}

// --------------------------------------------------------------- conversion

const first = (o: Raw, ...names: string[]) => names.map((n) => o[n]).find((v) => v !== undefined && v !== null);
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" ? String(v) : "");

/** A list, or one string split on ; | / or newlines (commas are left alone: they may be part of a phrase). */
function listOf(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[;|\n]/) : [];
  return items.map(clean).filter(Boolean);
}

/** Read one raw record into a candidate plus any shape problems. Content rules are applied afterwards by validateBankWord. */
export function toCandidate(raw: Raw): { candidate: ImportCandidate | null; errors: BankIssue[]; warnings: BankIssue[] } {
  const errors: BankIssue[] = [];
  const warnings: BankIssue[] = [];
  if (raw.__notObject) return { candidate: null, errors: [{ severity: "error", code: "not_object", field: "word", message: "This entry is not a word record." }], warnings };

  const cefrRaw = clean(first(raw, "level", "cefr", "cefrlevel"));
  const cefr = normalizeCefr(cefrRaw);
  const pos = normalizePartOfSpeech(first(raw, "partofspeech", "pos"));
  const hintsRaw = Array.isArray(raw.hints) ? raw.hints.map(clean) : [raw.hint1, raw.hint2, raw.hint3, raw.hint4].map(clean);
  while (hintsRaw.length > HINT_COUNT && !hintsRaw[hintsRaw.length - 1]) hintsRaw.pop();
  const ja = first(raw, "giverja", "japanese", "ja", "japanesemeaning");
  const giverJa = Array.isArray(ja) ? ja.map(clean).filter(Boolean).join("、") : clean(ja);
  const openingQuestion = clean(first(raw, "openingquestion", "spokenopeningquestion", "opening", "spokenopening"));
  // Provenance is preserved when the file says so. A bare `id` only counts as a source id for words that came from Classroom Quiz Show.
  const source: BankWord["source"] = clean(raw.source) === "classroom-quiz-show" ? "classroom-quiz-show" : "file";
  const sourceId = clean(raw.sourceid || (source === "classroom-quiz-show" ? raw.id : "")).slice(0, 80);
  const status = clean(raw.status).toLowerCase();
  if (status && status !== "draft") warnings.push({ severity: "warning", code: "status_ignored", field: "status", message: `The file says "${status}", but every imported word starts as a draft and must be approved by a teacher.` });

  const candidate: ImportCandidate = {
    word: clean(first(raw, "word", "target", "answer")),
    accept: listOf(first(raw, "accept", "acceptedanswers", "alternatives")),
    partOfSpeech: pos ?? "noun",
    category: clean(raw.category),
    cefr: cefr ?? "A1",
    ...(clean(raw.topic) ? { topic: clean(raw.topic) } : {}),
    ...(giverJa ? { giverJa } : {}),
    ...(openingQuestion ? { openingQuestion } : {}),
    ...(clean(raw.meaning) ? { meaning: clean(raw.meaning) } : {}),
    ...(clean(raw.example) ? { example: clean(raw.example) } : {}),
    hints: hintsRaw,
    source,
    ...(sourceId ? { sourceId } : {}),
  };
  if (!pos) errors.push({ severity: "error", code: "bad_pos", field: "partOfSpeech", message: "Part of speech must be noun, verb, adjective, adverb or phrase." });
  if (!cefr) errors.push({ severity: "error", code: "bad_cefr", field: "cefr", message: `CEFR level must be one of ${CEFR_LEVELS.join(", ")}.` });
  return { candidate, errors, warnings };
}

export interface AnalyzeOptions {
  /** Words already in the bank (any status). Duplicates against non-archived ones are never imported. */
  existing?: readonly (Pick<BankWord, "word" | "accept" | "status"> & { cefr?: string; hints?: readonly string[] })[];
}

export function analyzeImport(text: string, format: ImportFormat, options: AnalyzeOptions = {}): ImportAnalysis {
  const empty = (fileErrors: string[]): ImportAnalysis => ({ fileErrors, records: [], counts: { total: 0, valid: 0, warning: 0, review: 0, duplicate: 0, invalid: 0, importable: 0 } });
  const parsed = parseRecords(text, format);
  if (parsed.fileErrors.length) return empty(parsed.fileErrors);
  if (parsed.records.length > MAX_IMPORT) return empty([`The file has ${parsed.records.length} words; the most that can be previewed at once is ${MAX_IMPORT}. Split it into smaller files.`]);

  const live = (options.existing ?? []).filter((w) => w.status !== "archived");
  const accepted = new Map<string, string>(); // normalised accepted form → the word that accepts it
  for (const w of live) for (const a of w.accept ?? []) { const n = normalize(a); if (n && !accepted.has(n)) accepted.set(n, w.word); }
  const seenInFile: { index: number; word: string; cefr: string; hints: string[] }[] = [];

  const records = parsed.records.map((raw, i): AnalyzedRecord => {
    const index = i + 1;
    const { candidate, errors: shapeErrors, warnings: shapeWarnings } = toCandidate(raw);
    if (!candidate) return { index, status: "invalid", candidate: null, errors: shapeErrors, warnings: shapeWarnings, importable: false };

    const issues = validateBankWord({ ...candidate, accept: candidate.accept });
    const errors = [...shapeErrors, ...errorsOf(issues).filter((e) => !(e.code === "bad_pos" || e.code === "bad_cefr"))];
    const warnings = [...shapeWarnings, ...warningsOf(issues)];
    // Structural and leakage errors are strict: they come before any duplicate handling.
    if (errors.length) return { index, status: "invalid", candidate, errors, warnings, importable: false };

    // Same target word elsewhere (the bank or an earlier row)? Identical = rejected; different level / hints = the teacher decides.
    const kinds: { kind: ReturnType<typeof sameWordKind>; where: string }[] = [];
    for (const w of live) kinds.push({ kind: sameWordKind(candidate, w), where: "in the bank" });
    for (const w of seenInFile) kinds.push({ kind: sameWordKind(candidate, w), where: `in row ${w.index} of this file` });
    const hit = kinds.filter((k) => k.kind);
    const identical = hit.find((k) => k.kind === "identical");
    if (identical) return { index, status: "duplicate", candidate, errors, warnings, note: `${SAME_WORD_NOTE.identical} (${identical.where})`, importable: false };
    // An earlier row that was itself held for review still counts as "seen", so a third copy is compared against it too.
    seenInFile.push({ index, word: candidate.word, cefr: candidate.cefr, hints: candidate.hints });
    if (hit.length) {
      const first = hit.find((k) => k.kind === "different_level") ?? hit[0];
      return { index, status: "review", candidate, errors, warnings, note: `${SAME_WORD_NOTE[first.kind!]} (${first.where})`, importable: false, needsDecision: true };
    }

    // A different word whose accepted answer is this word (or vice versa) may be the same question.
    const k = normalize(candidate.word);
    const clash = formsOf(candidate).find((f) => accepted.has(f) && f !== k) ?? (accepted.has(k) ? k : undefined);
    if (clash) return { index, status: "review", candidate, errors, warnings, note: `"${accepted.get(clash)}" in the bank already accepts "${clash}" as a correct answer. Check the two are not the same question.`, importable: false, needsDecision: true };

    return { index, status: warnings.length ? "warning" : "valid", candidate, errors, warnings, importable: true };
  });

  const n = (s: RecordStatus) => records.filter((r) => r.status === s).length;
  return { fileErrors: [], records, counts: { total: records.length, valid: n("valid"), warning: n("warning"), review: n("review"), duplicate: n("duplicate"), invalid: n("invalid"), importable: records.filter((r) => r.importable).length } };
}

/**
 * The words an import would create, always as DRAFTS with fresh opaque ids. Nothing is saved here.
 * Importable records are included; "review" records only when the teacher kept them (`keep` = their 1-based row numbers).
 * Duplicates and invalid records can never be kept.
 */
export function draftsFromAnalysis(analysis: ImportAnalysis, now: string, makeId: () => string = () => newId("b"), keep: ReadonlySet<number> = new Set()): BankWord[] {
  return analysis.records.filter((r) => r.candidate && (r.importable || (r.needsDecision && keep.has(r.index)))).map((r) => {
    const c = r.candidate!;
    return {
      id: makeId(),
      word: c.word,
      accept: c.accept,
      partOfSpeech: c.partOfSpeech,
      category: c.category,
      cefr: c.cefr,
      ...(c.topic ? { topic: c.topic } : {}),
      ...(c.giverJa ? { giverJa: c.giverJa } : {}),
      ...(c.openingQuestion ? { openingQuestion: c.openingQuestion } : {}),
      ...(c.meaning ? { meaning: c.meaning } : {}),
      ...(c.example ? { example: c.example } : {}),
      hints: [c.hints[0], c.hints[1], c.hints[2], c.hints[3]] as BankWord["hints"],
      status: "draft" as const,
      source: c.source,
      ...(c.sourceId ? { sourceId: c.sourceId } : {}),
      createdAt: now,
      updatedAt: now,
    };
  });
}

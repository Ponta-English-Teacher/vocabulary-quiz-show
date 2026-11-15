import { createHash } from "node:crypto";
import { normalizeCefr, normalizePartOfSpeech } from "@/lib/studio/validation";
import { newId } from "@/lib/studio/ids";
import { analyzeImport, detectFormat, draftsFromAnalysis, type ImportAnalysis, type ImportFormat } from "./import";
import { approveWord, archiveWord, editWord, restoreWord } from "./status";
import { KEYS, type BankStore } from "./store";
import { BANK_FORMAT, BANK_VERSION, HINT_COUNT, type BankIssue, type BankStatus, type BankWord } from "./types";
import { errorsOf, identityKey, validateBankWord } from "./validate";

/**
 * The word-bank operations (Phase 2). All rules come from Phase 1 (validation, duplicate detection, approval); this layer only stores.
 * It reads and writes ONLY the three word-bank keys (see store.ts) and never touches classroom data, the browser bank or saved activities.
 */
export type ServiceError = { ok: false; code: "not_found" | "bad_request" | "conflict" | "invalid"; message: string; issues?: BankIssue[] };
const fail = (code: ServiceError["code"], message: string, issues?: BankIssue[]): ServiceError => ({ ok: false, code, message, ...(issues ? { issues } : {}) });

export const MAX_APPROVE_MANY = 200;
export const MAX_IMPORT_CHARS = 6_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Whether a word's identity can be claimed: it needs a word, a valid level and four non-empty hints. */
const complete = (w: BankWord) => !!w.word?.trim() && !!normalizeCefr(w.cefr) && Array.isArray(w.hints) && w.hints.length === HINT_COUNT && w.hints.every((h) => typeof h === "string" && h.trim());
const identOf = (w: BankWord) => sha(identityKey(w));

export interface ListFilter { status?: BankStatus; cefr?: string; category?: string; q?: string }
export interface Counts { draft: number; approved: number; archived: number; total: number }

export interface ImportOutcome {
  importId: string;
  /** True when this exact import was already done: nothing was written this time. */
  replayed: boolean;
  created: number;
  createdIds: string[];
  skipped: { duplicate: number; invalid: number; heldForReview: number; alreadyAdded: number };
  total: number;
}

export interface BankExportFile {
  format: typeof BANK_FORMAT;
  version: typeof BANK_VERSION;
  exportedAt: string;
  counts: Counts;
  words: BankWord[];
}

const textOrUndef = (v: unknown): string | undefined | "bad" => (v === undefined ? undefined : typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "bad");

/** Read the editable fields of a request. Unknown fields (id, status, source…) are ignored: they can never be set through the API. */
function coerce(patch: unknown): { out: Parameters<typeof editWord>[1] } | ServiceError {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return fail("bad_request", "Nothing to change.");
  const p = patch as Record<string, unknown>;
  const out: Parameters<typeof editWord>[1] = {};
  for (const k of ["word", "category", "topic", "giverJa", "openingQuestion", "meaning", "example"] as const) {
    if (!(k in p)) continue;
    const v = textOrUndef(p[k]);
    if (v === "bad") return fail("bad_request", `${k} must be text.`);
    if ((k === "word" || k === "category") && !v) return fail("bad_request", `${k} cannot be empty.`);
    (out as Record<string, unknown>)[k] = v || undefined;
  }
  if ("accept" in p) {
    if (!Array.isArray(p.accept) || p.accept.some((a) => typeof a !== "string")) return fail("bad_request", "accept must be a list of text.");
    out.accept = (p.accept as string[]).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean);
  }
  if ("hints" in p) {
    if (!Array.isArray(p.hints) || p.hints.some((h) => typeof h !== "string")) return fail("bad_request", "hints must be a list of text.");
    out.hints = (p.hints as string[]).map((h) => h.replace(/\s+/g, " ").trim()) as unknown as BankWord["hints"];
  }
  if ("partOfSpeech" in p) {
    const pos = normalizePartOfSpeech(p.partOfSpeech);
    if (!pos) return fail("bad_request", "Part of speech must be noun, verb, adjective, adverb or phrase.");
    out.partOfSpeech = pos;
  }
  if ("cefr" in p) {
    const c = normalizeCefr(p.cefr);
    if (!c) return fail("bad_request", "CEFR level must be A1, A2, B1, B2, C1 or C2.");
    out.cefr = c;
  }
  return { out };
}

export class BankService {
  constructor(private store: BankStore, private now: () => string = () => new Date().toISOString(), private makeId: () => string = () => newId("b")) {}

  private async readAll(): Promise<{ words: BankWord[]; unreadable: number }> {
    const raw = await this.store.hgetall(KEYS.words);
    const words: BankWord[] = [];
    let unreadable = 0;
    for (const [id, json] of Object.entries(raw)) {
      try {
        const w = JSON.parse(json) as BankWord;
        if (w && typeof w === "object" && w.id === id && typeof w.word === "string") words.push(w);
        else unreadable++;
      } catch {
        unreadable++;
      }
    }
    words.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    return { words, unreadable };
  }

  private async load(id: string): Promise<BankWord | null> {
    const json = await this.store.hget(KEYS.words, id);
    if (!json) return null;
    try {
      const w = JSON.parse(json) as BankWord;
      return w && w.id === id ? w : null;
    } catch {
      return null;
    }
  }

  private save(w: BankWord) { return this.store.hset(KEYS.words, w.id, JSON.stringify(w)); }

  /** Claim the identity of a live word. False = a DIFFERENT live word already has exactly this word + level + hints. */
  private async claim(w: BankWord): Promise<boolean> {
    if (!complete(w)) return true;
    const h = identOf(w);
    if (await this.store.hsetnx(KEYS.ident, h, w.id)) return true;
    const owner = await this.store.hget(KEYS.ident, h);
    if (owner === w.id) return true;
    const ow = owner ? await this.load(owner) : null;
    if (ow && ow.status !== "archived" && complete(ow) && identOf(ow) === h) return false;
    await this.store.hset(KEYS.ident, h, w.id); // the claim was left behind by an interrupted write: take it over
    return true;
  }

  private async release(w: BankWord) {
    if (!complete(w)) return;
    const h = identOf(w);
    if ((await this.store.hget(KEYS.ident, h)) === w.id) await this.store.hdel(KEYS.ident, h);
  }

  // ------------------------------------------------------------------ list

  async list(filter: ListFilter = {}): Promise<{ words: BankWord[]; counts: Counts; unreadable: number }> {
    const { words, unreadable } = await this.readAll();
    const counts: Counts = { draft: 0, approved: 0, archived: 0, total: words.length };
    for (const w of words) if (w.status in counts) counts[w.status]++;
    const q = filter.q?.trim().toLowerCase();
    return {
      words: words.filter((w) => (!filter.status || w.status === filter.status) && (!filter.cefr || w.cefr === filter.cefr) && (!filter.category || w.category === filter.category) && (!q || w.word.toLowerCase().includes(q))),
      counts,
      unreadable,
    };
  }

  // ---------------------------------------------------------------- import

  /** The id of an import: the same file with the same choices always gets the same id, so a retry is recognised. */
  importId(text: string, format: ImportFormat, keep: readonly number[] = []): string {
    return sha(`${format}\u0001${[...new Set(keep)].sort((a, b) => a - b).join(",")}\u0001${text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim()}`);
  }

  /** Check a file against the bank. Writes nothing. */
  async previewImport(text: string, filename?: string): Promise<{ analysis: ImportAnalysis; format: ImportFormat }> {
    const format = detectFormat(text, filename);
    const { words } = await this.readAll();
    return { analysis: analyzeImport(text, format, { existing: words }), format };
  }

  /**
   * Import a file as DRAFTS. Safe to retry: the same file is recognised and writes nothing the second time, and identical records can never be
   * created twice even if two requests overlap. `keep` = row numbers of "review" records the teacher chose to keep.
   */
  async importDrafts(text: string, filename?: string, keep: readonly number[] = []): Promise<ImportOutcome | ServiceError> {
    if (typeof text !== "string" || !text.trim()) return fail("bad_request", "The file is empty.");
    if (text.length > MAX_IMPORT_CHARS) return fail("bad_request", "The file is too large.");
    const format = detectFormat(text, filename);
    const importId = this.importId(text, format, keep);

    const prior = await this.store.hget(KEYS.imports, importId);
    if (prior) {
      try {
        return { ...(JSON.parse(prior) as ImportOutcome), replayed: true };
      } catch {
        /* unreadable record: fall through and import again (duplicates are still refused below) */
      }
    }

    const { words } = await this.readAll();
    const analysis = analyzeImport(text, format, { existing: words });
    if (analysis.fileErrors.length) return fail("invalid", analysis.fileErrors[0]);

    const now = this.now();
    const drafts = draftsFromAnalysis(analysis, now, this.makeId, new Set(keep));
    const createdIds: string[] = [];
    let raced = 0;
    for (const d of drafts) {
      if (!(await this.claim(d))) { raced++; continue; }
      await this.save(d);
      createdIds.push(d.id);
    }
    const c = analysis.counts;
    const outcome: ImportOutcome = {
      importId,
      replayed: false,
      created: createdIds.length,
      createdIds,
      skipped: { duplicate: c.duplicate, invalid: c.invalid, heldForReview: analysis.records.filter((r) => r.needsDecision && !keep.includes(r.index)).length, alreadyAdded: raced },
      total: c.total,
    };
    await this.store.hset(KEYS.imports, importId, JSON.stringify(outcome));
    return outcome;
  }

  // ---------------------------------------------------------------- create

  /** Write a new word by hand (no AI). It always starts as a DRAFT with source "manual". Hints may be unfinished; approval checks them. */
  async create(input: unknown): Promise<{ ok: true; word: BankWord; issues: BankIssue[] } | ServiceError> {
    const c = coerce(input);
    if (!("out" in c)) return c;
    const o = c.out;
    if (!o.word || !o.category || !o.partOfSpeech || !o.cefr) return fail("bad_request", "A new word needs the word, part of speech, category and CEFR level.");
    const hints = [...(o.hints ?? [])];
    if (hints.length > HINT_COUNT) return fail("bad_request", `A word has exactly ${HINT_COUNT} hints.`);
    while (hints.length < HINT_COUNT) hints.push("");
    const now = this.now();
    const w: BankWord = {
      id: this.makeId(), word: o.word, accept: o.accept ?? [], partOfSpeech: o.partOfSpeech, category: o.category, cefr: o.cefr,
      ...(o.topic ? { topic: o.topic } : {}), ...(o.giverJa ? { giverJa: o.giverJa } : {}), ...(o.openingQuestion ? { openingQuestion: o.openingQuestion } : {}), ...(o.meaning ? { meaning: o.meaning } : {}), ...(o.example ? { example: o.example } : {}),
      hints: hints as unknown as BankWord["hints"], status: "draft", source: "manual", createdAt: now, updatedAt: now,
    };
    if (complete(w) && !(await this.claim(w))) return fail("conflict", "An identical word (same word, level and hints) is already in the bank.");
    await this.save(w);
    return { ok: true, word: w, issues: validateBankWord(w) };
  }

  // ------------------------------------------------------------------ edit

  /** Edit content. The word returns to draft and must be approved again. Saved even if it still has problems (they are returned). */
  async edit(id: string, patch: unknown): Promise<{ ok: true; word: BankWord; issues: BankIssue[] } | ServiceError> {
    const w = await this.load(id);
    if (!w) return fail("not_found", "That word does not exist.");
    if (w.status === "archived") return fail("conflict", "Restore an archived word before editing it.");
    const c = coerce(patch);
    if (!("out" in c)) return c;
    const out = c.out;
    // Provenance, status and ids can never be changed through an edit.
    const next = editWord(w, out, this.now());
    if (complete(next) && !(await this.claim(next))) return fail("conflict", "An identical word (same word, level and hints) is already in the bank.");
    await this.save(next);
    if (complete(w) && (!complete(next) || identOf(w) !== identOf(next))) await this.release(w);
    return { ok: true, word: next, issues: validateBankWord(next) };
  }

  // ---------------------------------------------------- approve / archive

  async approve(id: string): Promise<{ ok: true; word: BankWord } | ServiceError> {
    const { words } = await this.readAll();
    const w = words.find((x) => x.id === id);
    if (!w) return fail("not_found", "That word does not exist.");
    const r = approveWord(w, this.now(), words);
    if (!r.ok) return fail("invalid", r.error, validateBankWord(w));
    await this.save(r.word);
    return { ok: true, word: r.word };
  }

  /** Approve several words; each is checked on its own, so one problem never blocks the rest. */
  async approveMany(ids: unknown): Promise<{ ok: true; approved: string[]; failed: { id: string; message: string }[] } | ServiceError> {
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== "string")) return fail("bad_request", "Choose at least one word.");
    if (ids.length > MAX_APPROVE_MANY) return fail("bad_request", `Approve at most ${MAX_APPROVE_MANY} words at a time.`);
    const { words } = await this.readAll();
    const byId = new Map(words.map((w) => [w.id, w]));
    const approved: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const id of [...new Set(ids as string[])]) {
      const w = byId.get(id);
      if (!w) { failed.push({ id, message: "That word does not exist." }); continue; }
      const r = approveWord(w, this.now(), [...byId.values()]);
      if (!r.ok) { failed.push({ id, message: r.error }); continue; }
      await this.save(r.word);
      byId.set(id, r.word);
      approved.push(id);
    }
    return { ok: true, approved, failed };
  }

  /**
   * Archive several DRAFTS at once. All-or-nothing: if ANY id is missing, approved or already archived, nothing is changed and every problem is
   * reported. Only status and the duplicate-check claim change (the same as archiving one draft); hints, import history and approved words are untouched.
   */
  async archiveDrafts(ids: unknown): Promise<{ ok: true; archived: string[] } | { ok: false; code: "bad_request" | "conflict"; message: string; rejected: { id: string; message: string }[] }> {
    const bad = (message: string) => ({ ok: false as const, code: "bad_request" as const, message, rejected: [] });
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== "string")) return bad("Choose at least one draft.");
    const unique = [...new Set(ids as string[])];
    if (unique.length > MAX_APPROVE_MANY) return bad(`Archive at most ${MAX_APPROVE_MANY} drafts at a time.`);
    const { words } = await this.readAll();
    const byId = new Map(words.map((w) => [w.id, w]));
    const rejected: { id: string; message: string }[] = [];
    for (const id of unique) {
      const w = byId.get(id);
      if (!w) rejected.push({ id, message: "That word does not exist." });
      else if (w.status !== "draft") rejected.push({ id, message: `“${w.word}” is ${w.status}, not a draft, so it was not archived.` });
    }
    if (rejected.length) return { ok: false, code: "conflict", message: `Nothing was archived: ${rejected.length} of the ${unique.length} selected ${rejected.length === 1 ? "is" : "are"} not a draft. ${rejected[0].message}`, rejected };
    const archived: string[] = [];
    for (const id of unique) {
      const w = byId.get(id)!;
      await this.save(archiveWord(w, this.now()));
      await this.release(w);
      archived.push(id);
    }
    return { ok: true, archived };
  }

  async archive(id: string): Promise<{ ok: true; word: BankWord } | ServiceError> {
    const w = await this.load(id);
    if (!w) return fail("not_found", "That word does not exist.");
    const a = archiveWord(w, this.now());
    await this.save(a);
    await this.release(w);
    return { ok: true, word: a };
  }

  /** Restoring brings the word back as a DRAFT (never approved), unless an identical live word now exists. */
  async restore(id: string): Promise<{ ok: true; word: BankWord } | ServiceError> {
    const w = await this.load(id);
    if (!w) return fail("not_found", "That word does not exist.");
    if (w.status !== "archived") return fail("conflict", "That word is not archived.");
    const back = restoreWord(w, this.now());
    if (!(await this.claim(back))) return fail("conflict", "An identical word (same word, level and hints) is already in the bank, so this one cannot be restored.");
    await this.save(back);
    return { ok: true, word: back };
  }

  // ---------------------------------------------------------------- export

  /** The complete bank, every status, with source and sourceId. The file can be previewed and imported again. */
  async exportAll(): Promise<BankExportFile> {
    const { words, counts } = await this.list();
    return { format: BANK_FORMAT, version: BANK_VERSION, exportedAt: this.now(), counts, words };
  }
}

export const hasErrors = (w: BankWord) => errorsOf(validateBankWord(w)).length > 0;

import type { VocabWord } from "@/data/vocab";
import { CEFR_LEVELS } from "@/data/vocab";
import { clampPlayCount } from "@/lib/playCount";
import { convertExport, parseCqsExport, type ImportItem, type ImportReport } from "./cqsImport";
import type { StorageLike } from "./storage";

/**
 * The teacher's question bank: a Classroom Quiz Show export remembered in THIS browser (localStorage), so it does not have to be
 * chosen again. Only the raw, trimmed questions are stored; the conversion (cqsImport.ts) is re-run when it is loaded, so improvements
 * to the converter apply to an already-saved bank. It is separate from saved activities and never touches them.
 */
export const BANK_KEY = "vqs.cqsBank.v1";
/** The most words one pair game can use (the class API accepts 1–50). */
export const MAX_GAME_WORDS = 50;
export const DEFAULT_GAME_WORDS = 10;

export interface SavedBank {
  v: 1;
  fileName: string;
  exportedAt: string;
  savedAt: string;
  questions: unknown[];
  /** How the bank got here. Older saved banks have neither and count as "file". */
  origin?: "file" | "sync";
  /** When the bank was last successfully synchronized from Classroom Quiz Show (ISO). Only for origin "sync". */
  syncedAt?: string;
  /** Version tag of the synchronized bank, sent back so an unchanged bank is not downloaded again. */
  etag?: string;
}

const KEEP = ["id", "cefrLevel", "categoryId", "categoryName", "prompt", "chunks", "choices", "correctIndex", "answer", "status"] as const;
const trim = (q: unknown): unknown => {
  if (!q || typeof q !== "object") return q;
  const src = q as Record<string, unknown>;
  return Object.fromEntries(KEEP.filter((k) => k in src).map((k) => [k, src[k]]));
};

export type BankResult = { ok: true; bank: SavedBank; remembered: boolean } | { ok: false; error: string };

/** Build a bank from an export's text WITHOUT saving it. */
export function makeBank(fileName: string, text: string, now = new Date(), extra: Partial<SavedBank> = {}): { ok: true; bank: SavedBank } | { ok: false; error: string } {
  const parsed = parseCqsExport(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, bank: { v: 1, fileName, exportedAt: parsed.exportedAt, savedAt: now.toISOString(), questions: parsed.questions.map(trim), origin: "file", ...extra } };
}

/** Remember a bank in this browser. Returns false when the browser would not store it (the bank still works until the page is closed). */
export function saveBank(storage: StorageLike | null, bank: SavedBank): boolean {
  try {
    storage?.setItem(BANK_KEY, JSON.stringify(bank));
    return !!storage;
  } catch {
    return false;
  }
}

/** Read an export file's text into a bank and remember it. A bad file returns an error and changes nothing that was saved before. */
export function bankFromText(storage: StorageLike | null, fileName: string, text: string, now = new Date()): BankResult {
  const made = makeBank(fileName, text, now);
  if (!made.ok) return made;
  return { ok: true, bank: made.bank, remembered: saveBank(storage, made.bank) };
}

export function loadBank(storage: StorageLike | null): SavedBank | null {
  try {
    const raw = storage?.getItem(BANK_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as Partial<SavedBank>;
    return b && b.v === 1 && Array.isArray(b.questions)
      ? {
          v: 1, fileName: String(b.fileName ?? "question bank"), exportedAt: String(b.exportedAt ?? ""), savedAt: String(b.savedAt ?? ""), questions: b.questions,
          origin: b.origin === "sync" ? "sync" : "file",
          ...(typeof b.syncedAt === "string" ? { syncedAt: b.syncedAt } : {}),
          ...(typeof b.etag === "string" ? { etag: b.etag } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

export function clearBank(storage: StorageLike & { removeItem?: (k: string) => void }): void {
  try {
    if (storage.removeItem) storage.removeItem(BANK_KEY);
    else storage.setItem(BANK_KEY, "");
  } catch {
    /* ignore */
  }
}

export const convertBank = (bank: SavedBank): ImportReport => convertExport(bank.questions);

export interface BankFilter {
  cefr: string; // "all" or a level
  category: string; // "all" or a category name
}

const matches = (i: ImportItem, f: BankFilter) => (f.cefr === "all" || i.cefr === f.cefr) && (f.category === "all" || i.category === f.category);

/** The importable questions that match the filter, split into ready ones (used by default) and flagged ones (only if the teacher picks them). */
export function filterBank(report: ImportReport, f: BankFilter): { ready: ImportItem[]; flagged: ImportItem[] } {
  const usable = report.items.filter((i) => i.word && i.status !== "skipped" && matches(i, f));
  return { ready: usable.filter((i) => i.status === "ready"), flagged: usable.filter((i) => i.status === "flagged") };
}

export function bankCategories(report: ImportReport): string[] {
  return [...new Set(report.items.filter((i) => i.word && i.status !== "skipped").map((i) => i.category))].sort();
}
export function bankLevels(report: ImportReport): string[] {
  const have = new Set(report.items.filter((i) => i.word && i.status !== "skipped").map((i) => i.cefr));
  return (CEFR_LEVELS as readonly string[]).filter((l) => have.has(l));
}

export interface GamePick {
  words: VocabWord[];
  /** How many usable questions matched (ready + the flagged ones the teacher ticked). */
  available: number;
  /** Words actually used. */
  count: number;
  /** True when fewer were available than requested. */
  short: boolean;
  usedFlagged: number;
}

/** Fisher–Yates with an injectable random source (so tests are deterministic). */
export function shuffle<T>(list: readonly T[], rng: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Choose the words for one game: the flagged questions the teacher ticked come first, then ready ones in random order, up to `requested`
 * (never more than MAX_GAME_WORDS). Flagged questions that were not ticked are never used.
 */
export function pickForGame(
  pool: { ready: ImportItem[]; flagged: ImportItem[] },
  requested: number,
  chosenFlagged: ReadonlySet<string>,
  rng: () => number = Math.random,
): GamePick {
  const ticked = pool.flagged.filter((i) => chosenFlagged.has(i.sourceId));
  const available = pool.ready.length + ticked.length;
  const want = clampPlayCount(requested, Math.min(MAX_GAME_WORDS, Math.max(1, available)));
  const chosen = [...shuffle(ticked, rng), ...shuffle(pool.ready, rng)].slice(0, Math.min(want, available));
  return {
    words: chosen.map((i) => i.word as VocabWord),
    available,
    count: chosen.length,
    short: requested > available,
    usedFlagged: chosen.filter((i) => i.status === "flagged").length,
  };
}

/** A synchronized bank that has fewer ready questions than this share of the saved one needs the teacher's confirmation. */
export const SHRINK_CONFIRM_BELOW = 0.5;
export const SYNC_BANK_NAME = "Classroom Quiz Show (synced)";

export type SyncEvaluation =
  | { ok: false; error: string }
  | {
      ok: true;
      incoming: SavedBank;
      /** Ready questions in the saved bank (null when there is none) and in the incoming one. */
      readyBefore: number | null;
      readyAfter: number;
      counts: ImportReport["counts"];
      /** True when the incoming bank has more than 50% fewer ready questions than the saved one: do not accept without a yes. */
      needsConfirm: boolean;
    };

/**
 * Judge a bank that arrived from Classroom Quiz Show BEFORE anything is saved. Nothing is replaced here.
 * A bank that cannot be read, or has no ready question at all, is refused; a bank with more than 50% fewer ready questions than the
 * saved one is accepted only after `needsConfirm` has been answered yes.
 */
export function evaluateSync(current: SavedBank | null, text: string, etag: string | undefined, now = new Date()): SyncEvaluation {
  const made = makeBank(SYNC_BANK_NAME, text, now, { origin: "sync", syncedAt: now.toISOString(), ...(etag ? { etag } : {}) });
  if (!made.ok) return made;
  const counts = convertBank(made.bank).counts;
  const readyBefore = current ? convertBank(current).counts.ready : null;
  if (counts.ready === 0 && !(readyBefore && readyBefore > 0)) return { ok: false, error: "Classroom Quiz Show sent no usable questions, so nothing was changed." };
  const needsConfirm = readyBefore !== null && readyBefore > 0 && counts.ready < readyBefore * SHRINK_CONFIRM_BELOW;
  return { ok: true, incoming: made.bank, readyBefore, readyAfter: counts.ready, counts, needsConfirm };
}

/** Nothing changed on the server: keep the saved questions and record that a check succeeded now. */
export function markSynced(storage: StorageLike | null, bank: SavedBank, now = new Date()): { bank: SavedBank; remembered: boolean } {
  const next: SavedBank = { ...bank, origin: "sync", syncedAt: now.toISOString() };
  return { bank: next, remembered: saveBank(storage, next) };
}

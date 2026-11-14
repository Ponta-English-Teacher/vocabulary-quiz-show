import { BANK_KEY, loadBank, convertBank } from "./cqsBank";
import { STORAGE_KEY, type StorageLike } from "./storage";
import { TRIED_KEY } from "./autoJapanese";

/**
 * Export Backup: everything the teacher keeps in THIS browser, as one JSON file. Read-only: it never writes, changes or removes
 * anything. The teacher passcode (also kept in this browser) is deliberately NOT included.
 *
 *   bank        the saved question bank exactly as stored (original trimmed CQS records, origin, etag, dates)
 *   bankReport  how the current converter reads that bank: ready / flagged / skipped per question, with reasons and the converted word
 *   activities  all saved Studio activities exactly as stored (sets, words, hints, hand edits)
 *   other       small helper records (study-Japanese attempt log)
 */
export const BACKUP_FORMAT = "vocabulary-quiz-show/backup";
export const BACKUP_VERSION = 1;

/** The browser keys a backup covers. The passcode key is intentionally absent. */
export const BACKUP_KEYS = [BANK_KEY, STORAGE_KEY, TRIED_KEY] as const;

/** The stored value exactly as parsed; null when nothing is saved; { unreadableText } (the original text) when it is damaged. */
function readRaw(storage: StorageLike | null, key: string): unknown {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return { unreadable: true };
  }
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { unreadableText: raw }; // keep the original text so nothing is lost
  }
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  note: string;
  summary: { bankQuestions: number; bankReady: number; bankFlagged: number; bankSkipped: number; activities: number; sets: number; words: number };
  bank: unknown;
  bankReport: unknown;
  activities: unknown;
  other: Record<string, unknown>;
}

export function buildBackup(storage: StorageLike | null, now = new Date()): BackupFile {
  const bankRaw = readRaw(storage, BANK_KEY);
  const actsRaw = readRaw(storage, STORAGE_KEY);
  const triedRaw = readRaw(storage, TRIED_KEY);

  const bank = loadBank(storage);
  const report = bank ? convertBank(bank) : null;
  const list: { sets?: { words?: unknown[] }[] }[] = Array.isArray(actsRaw) ? actsRaw : [];
  const sets = list.reduce((n, a) => n + (Array.isArray(a.sets) ? a.sets.length : 0), 0);
  const words = list.reduce((n, a) => n + (Array.isArray(a.sets) ? a.sets.reduce((m, s) => m + (Array.isArray(s.words) ? s.words.length : 0), 0) : 0), 0);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    note: "Backup of this browser's Vocabulary Quiz Show data. Read-only copy: nothing was changed or removed. The teacher passcode is not included.",
    summary: {
      bankQuestions: report?.counts.total ?? 0,
      bankReady: report?.counts.ready ?? 0,
      bankFlagged: report?.counts.flagged ?? 0,
      bankSkipped: report?.counts.skipped ?? 0,
      activities: list.length,
      sets,
      words,
    },
    bank: bankRaw,
    bankReport: report,
    activities: actsRaw,
    other: { [TRIED_KEY]: triedRaw },
  };
}

export function backupFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `vqs-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** Offer the backup as a file download. Returns false if the browser could not do it. */
export function downloadBackup(storage: StorageLike | null, now = new Date()): { ok: boolean; filename: string; summary: BackupFile["summary"] } {
  const file = buildBackup(storage, now);
  const filename = backupFilename(now);
  try {
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, filename, summary: file.summary };
  } catch {
    return { ok: false, filename, summary: file.summary };
  }
}

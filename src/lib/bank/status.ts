import { errorsOf, isIdentical, validateBankWord } from "./validate";
import type { BankWord } from "./types";

/** Draft → Approved → Archived. Pure functions: they return a new word (or an error) and never mutate or store anything. */
export type StatusResult = { ok: true; word: BankWord } | { ok: false; error: string };

export const isPlayable = (w: Pick<BankWord, "status">) => w.status === "approved";

/** `others` = the rest of the bank. An approved word that is IDENTICAL to another live word is refused; other same-word entries are allowed (the teacher is approving on purpose). */
export function approveWord(w: BankWord, now: string, others: readonly BankWord[] = []): StatusResult {
  if (w.status === "archived") return { ok: false, error: "Restore an archived word before approving it." };
  const errors = errorsOf(validateBankWord(w));
  if (errors.length) return { ok: false, error: `Fix ${errors.length} problem${errors.length === 1 ? "" : "s"} before approving: ${errors[0].message}` };
  if (others.some((o) => o.id !== w.id && o.status !== "archived" && isIdentical(o, w))) return { ok: false, error: "An identical word (same word, level and hints) is already in the bank." };
  return { ok: true, word: { ...w, status: "approved", approvedAt: now, updatedAt: now } };
}

/** Editing content always returns a word to draft: a changed word has not been approved. */
export function editWord(w: BankWord, patch: Partial<Pick<BankWord, "word" | "accept" | "partOfSpeech" | "category" | "cefr" | "topic" | "giverJa" | "meaning" | "example" | "hints">>, now: string): BankWord {
  const { approvedAt: _a, ...rest } = w;
  void _a;
  return { ...rest, ...patch, status: w.status === "archived" ? "archived" : "draft", updatedAt: now };
}

export function archiveWord(w: BankWord, now: string): BankWord {
  if (w.status === "archived") return w;
  const { approvedAt: _a, ...rest } = w;
  void _a;
  return { ...rest, status: "archived", archivedFrom: w.status, updatedAt: now };
}

/** Restoring never re-approves: an archived word comes back as a draft. */
export function restoreWord(w: BankWord, now: string): BankWord {
  if (w.status !== "archived") return w;
  const { archivedFrom: _f, approvedAt: _a, ...rest } = w;
  void _f;
  void _a;
  return { ...rest, status: "draft", updatedAt: now };
}

export const demoteToDraft = (w: BankWord, now: string): BankWord => (w.status === "approved" ? editWord(w, {}, now) : w);

/** Games may only use approved words. */
export const playableWords = (words: readonly BankWord[]): BankWord[] => words.filter(isPlayable);

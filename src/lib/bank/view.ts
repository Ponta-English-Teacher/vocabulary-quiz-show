import { CEFR_LEVELS, type CefrLevel } from "@/data/vocab";
import type { Counts } from "./client";
import { HINT_COUNT, type BankIssue, type BankStatus, type BankWord } from "./types";
import { validateBankWord, type BankDraft } from "./validate";

/** Pure helpers for the Word Bank screens (kept out of the components so they can be tested without a browser). */

/** The four hints in play order: least helpful first. */
export const HINT_ROLES = [
  { n: 1, title: "Hint 1 · Opening", detail: "Free · least helpful · set a scene the Giver can talk about" },
  { n: 2, title: "Hint 2", detail: "A bit more helpful · one more concrete detail" },
  { n: 3, title: "Hint 3", detail: "More helpful · a clearer clue" },
  { n: 4, title: "Hint 4 · Most helpful", detail: "Last hint · the Taker should be able to guess now" },
] as const;

export const STATUS_LABEL: Record<BankStatus, string> = { draft: "Draft", approved: "Approved", archived: "Archived" };

/** Errors block approval. Warnings are for the teacher to judge and never block anything. */
export function splitIssues(issues: readonly BankIssue[]): { errors: BankIssue[]; warnings: BankIssue[] } {
  return { errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

export const issuesOf = (w: BankWord | BankDraft): { errors: BankIssue[]; warnings: BankIssue[] } => splitIssues(validateBankWord(w));

export const canApprove = (w: BankWord): boolean => w.status === "draft" && issuesOf(w).errors.length === 0;

export interface Filters { status: BankStatus | "all"; cefr: CefrLevel | "all"; category: string; q: string }
export const DEFAULT_FILTERS: Filters = { status: "draft", cefr: "all", category: "all", q: "" };

export function filterWords(words: readonly BankWord[], f: Filters): BankWord[] {
  const q = f.q.trim().toLowerCase();
  return words.filter((w) =>
    (f.status === "all" || w.status === f.status) &&
    (f.cefr === "all" || w.cefr === f.cefr) &&
    (f.category === "all" || w.category === f.category) &&
    (!q || [w.word, ...w.accept, w.category, w.topic ?? "", w.giverJa ?? ""].some((t) => t.toLowerCase().includes(q))),
  );
}

export const categoriesOf = (words: readonly BankWord[]): string[] => [...new Set(words.map((w) => w.category))].sort((a, b) => a.localeCompare(b));
export const levelsOf = (words: readonly BankWord[]): CefrLevel[] => CEFR_LEVELS.filter((l) => words.some((w) => w.cefr === l));

/** The one-line explanation of where the teacher is in Import → Review → Edit → Approve. */
export function workflowSummary(c: Counts): { step: string; text: string }[] {
  return [
    { step: "1 Import", text: "Add words from a file, or write one by hand." },
    { step: "2 Review", text: `${c.draft} draft${c.draft === 1 ? "" : "s"} waiting` },
    { step: "3 Edit", text: "Fix problems and improve the four hints." },
    { step: "4 Approve", text: `${c.approved} approved` },
  ];
}

export interface WordForm {
  word: string; accept: string; partOfSpeech: string; cefr: string; category: string; topic: string; giverJa: string; meaning: string; example: string; hints: string[];
}
export const blankForm = (): WordForm => ({ word: "", accept: "", partOfSpeech: "noun", cefr: "A2", category: "", topic: "", giverJa: "", meaning: "", example: "", hints: Array(HINT_COUNT).fill("") });

export const formFromWord = (w: BankWord): WordForm => ({
  word: w.word, accept: w.accept.join("; "), partOfSpeech: w.partOfSpeech, cefr: w.cefr, category: w.category, topic: w.topic ?? "", giverJa: w.giverJa ?? "",
  meaning: w.meaning ?? "", example: w.example ?? "", hints: [...w.hints, "", "", "", ""].slice(0, HINT_COUNT),
});

/** Accepted answers are typed separated by ; or a new line (commas can be part of a phrase). */
export const parseAccept = (s: string): string[] => s.split(/[;\n]/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);

/** What the server receives. Optional text left empty is sent as "" so it clears the field. */
export const payloadFromForm = (f: WordForm) => ({
  word: f.word, accept: parseAccept(f.accept), partOfSpeech: f.partOfSpeech, cefr: f.cefr, category: f.category, topic: f.topic, giverJa: f.giverJa, meaning: f.meaning, example: f.example, hints: f.hints,
});

/** Live checks while typing, with the same rules the server applies at approval. */
export function issuesForForm(f: WordForm): { errors: BankIssue[]; warnings: BankIssue[] } {
  return issuesOf({
    word: f.word, accept: parseAccept(f.accept), partOfSpeech: f.partOfSpeech as BankDraft["partOfSpeech"], cefr: f.cefr as CefrLevel, category: f.category,
    topic: f.topic || undefined, giverJa: f.giverJa || undefined, meaning: f.meaning || undefined, example: f.example || undefined, hints: f.hints,
  });
}

export const spokenWordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** A download in the browser. Returns false if the browser could not do it. */
export function downloadText(filename: string, mime: string, content: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

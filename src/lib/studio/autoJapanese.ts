import { normalize } from "@/lib/answer";
import type { StorageLike } from "./storage";
import { loadActivities, rewriteActivities } from "./storage";
import type { Activity } from "./types";
import { MAX_TRANSLATE_WORDS, type WordToTranslate } from "./ai/japanese";

/**
 * Existing approved vocabulary that has no Japanese at all gets STUDY translations automatically, without reopening or
 * re-approving anything:
 *   - only words with neither `ja` (scoring answers) nor `studyJa` are looked at, in approved sets only;
 *   - the result goes into `studyJa`, a separate field: scoring answers, definitions, hints, edits and approval are untouched;
 *   - one bounded request per Studio visit, and a word is never asked about again within RETRY_AFTER_MS, success or not.
 */
export const TRIED_KEY = "vqs.studyJaTried.v1";
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const hasJapanese = (w: { ja?: string[]; studyJa?: string[] }) => [...(w.ja ?? []), ...(w.studyJa ?? [])].some((j) => j.trim());

export function missingStudyJapanese(activities: Activity[]): WordToTranslate[] {
  const seen = new Set<string>();
  const out: WordToTranslate[] = [];
  for (const a of activities) {
    for (const s of a.sets) {
      if (s.status !== "approved") continue;
      for (const w of s.words) {
        const key = normalize(w.word);
        if (hasJapanese(w) || seen.has(key)) continue;
        seen.add(key);
        out.push({ word: w.word, partOfSpeech: w.partOfSpeech, meaning: w.meaning });
      }
    }
  }
  return out;
}

export function loadTried(storage: StorageLike | null): Record<string, number> {
  try {
    const raw = storage?.getItem(TRIED_KEY);
    const j = raw ? (JSON.parse(raw) as unknown) : {};
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveTried(storage: StorageLike | null, tried: Record<string, number>) {
  try {
    storage?.setItem(TRIED_KEY, JSON.stringify(tried));
  } catch {
    /* storage blocked: the next visit may ask again, which is only a small extra request */
  }
}

/** Put translations into `studyJa` for words that still have no Japanese. Returns how many words changed. */
export function applyStudyJapanese(storage: StorageLike | null, table: Record<string, string[]>): number {
  let changed = 0;
  rewriteActivities(storage, (a) => {
    let touched = false;
    const sets = a.sets.map((s) => {
      if (s.status !== "approved") return s;
      let setTouched = false;
      const words = s.words.map((w) => {
        const list = table[normalize(w.word)];
        if (!list?.length || hasJapanese(w)) return w;
        setTouched = true;
        changed++;
        return { ...w, studyJa: list };
      });
      if (!setTouched) return s;
      touched = true;
      return { ...s, words }; // status, name, locks and everything else are carried over as they are
    });
    return touched ? { ...a, sets } : a;
  });
  return changed;
}

export type Translate = (words: WordToTranslate[]) => Promise<Record<string, string[]>>;

/** One bounded pass. `translate` is the existing AI service; it is only called when there is something missing and not tried recently. */
export async function autoFillStudyJapanese(storage: StorageLike | null, translate: Translate, now = Date.now()): Promise<{ requested: number; filled: number }> {
  const tried = loadTried(storage);
  const pending = missingStudyJapanese(loadActivities(storage).activities)
    .filter((w) => tried[normalize(w.word)] === undefined || now - tried[normalize(w.word)] >= RETRY_AFTER_MS)
    .slice(0, MAX_TRANSLATE_WORDS);
  if (!pending.length) return { requested: 0, filled: 0 };
  for (const w of pending) tried[normalize(w.word)] = now; // marked first: a failed request is not repeated on every visit
  saveTried(storage, tried);
  try {
    const table = await translate(pending);
    return { requested: pending.length, filled: applyStudyJapanese(storage, table) };
  } catch {
    return { requested: pending.length, filled: 0 };
  }
}

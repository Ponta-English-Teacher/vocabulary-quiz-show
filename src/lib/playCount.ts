import type { VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";

/** How many words one game plays by default. A set may hold more; the teacher picks how many to play. */
export const DEFAULT_PLAY_COUNT = 5;

/** A whole number from 1 to `available`. Anything else (empty, NaN, decimals, out of range) is brought into range. */
export function clampPlayCount(n: unknown, available: number): number {
  const max = Math.max(1, Math.floor(available) || 1);
  const v = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return Math.min(DEFAULT_PLAY_COUNT, max);
  return Math.min(max, Math.max(1, Math.floor(v)));
}

/**
 * The words one game will use: the FIRST `count` words of the set, in the set's own order, without duplicates.
 * It is a pure function of the set, so every player always gets the same words in the same order, and the source set is never changed
 * (the words are the same objects, so hints, Japanese answers, Giver notes, question kinds and pictures all come along).
 */
export function selectWords(words: readonly VocabWord[], count: number): VocabWord[] {
  const seen = new Set<string>();
  const unique = words.filter((w) => {
    const key = normalize(w.word);
    if (seen.has(w.id) || seen.has(key)) return false;
    seen.add(w.id);
    seen.add(key);
    return true;
  });
  return unique.slice(0, clampPlayCount(count, unique.length));
}

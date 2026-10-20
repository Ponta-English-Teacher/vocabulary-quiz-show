import type { VocabWord } from "@/data/vocab";

export type AnswerCheck = "correct" | "close" | "wrong" | "empty";

/** Lower-case, strip accents/punctuation, collapse spaces. */
export function normalize(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** True if `needle` appears in `haystack` as a run of whole words. */
function containsWholeWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

const MAX_WORDS_IN_SENTENCE = 4;

/**
 * Judge a typed/dictated answer.
 *
 *  correct — matches the word (or an `accept` variant) after normalising.
 *            Dictation-friendly: "It's an umbrella." is accepted when the answer
 *            appears as whole words in a short reply (≤ 4 words).
 *  close   — one or two letters off (a spelling slip). NOT scored; the Taker is
 *            told they are close and can try again.
 *  wrong   — anything else.
 *  empty   — nothing typed (ignored by the game).
 */
export function checkAnswer(
  guess: string,
  word: Pick<VocabWord, "word" | "accept">,
): AnswerCheck {
  const g = normalize(guess);
  if (!g) return "empty";

  const targets = [word.word, ...(word.accept ?? [])].map(normalize).filter(Boolean);
  const tokenCount = g.split(" ").length;

  for (const t of targets) {
    if (g === t) return "correct";
    if (tokenCount <= MAX_WORDS_IN_SENTENCE && tokenCount > t.split(" ").length) {
      if (containsWholeWords(g, t)) return "correct";
    }
  }

  for (const t of targets) {
    const allowed = t.length >= 8 ? 2 : t.length >= 4 ? 1 : 0;
    if (allowed > 0 && levenshtein(g, t) <= allowed) return "close";
  }
  return "wrong";
}

/**
 * Scoring (easy to tune — change the numbers here only).
 *
 *   English points  = max(FLOOR, BASE − PER_HINT × extraHints)
 *   Japanese points = round(English points × JAPANESE_SHARE)        (a correct answer given in Japanese)
 *   Giver points    = round(points the Taker was awarded × GIVER_SHARE)
 *
 * The OPENING HINT is free: it is shown automatically at the start of every round and never costs points.
 * "extraHints" counts the optional prepared hints the Giver revealed PLUS any spoken hints added with the + button.
 *
 *   extra hints      : 0    1    2    3    4    5+
 *   English  (Taker) : 100  85   70   55   40   25
 *   Japanese (Taker) : 50   43   35   28   20   13
 *   Giver, English   : 50   43   35   28   20   13
 *   Giver, Japanese  : 25   22   18   14   10   7
 *
 * ROUNDING RULE (used everywhere, in one place): halves round UP (Math.round on positive numbers, so 42.5 → 43).
 * Every amount is an integer, so running totals stay integers; and because the Giver's bonus is computed from the
 * points the Taker actually received (not from the unrounded value), the result is deterministic and identical on
 * both phones.
 *
 * - A skipped word scores 0 for both players.
 * - Wrong answers (English or Japanese) cost nothing: we want students to keep trying.
 * - A correct answer ends the round, so a word can never be scored twice.
 */
export const SCORING = {
  BASE: 100,
  PER_HINT: 15,
  FLOOR: 25,
  GIVER_SHARE: 0.5,
  JAPANESE_SHARE: 0.5,
} as const;

/** Hints that are shown automatically at the start of a round and are free. */
export const FREE_HINTS = 1;

export type AnswerLanguage = "en" | "ja";

/** Points available for a correct ENGLISH answer, given the number of paid (extra) hints used. */
export function pointsForHints(extraHints: number): number {
  const hints = Math.max(0, Math.floor(extraHints));
  return Math.max(SCORING.FLOOR, SCORING.BASE - SCORING.PER_HINT * hints);
}

/** Points a Taker earns for a correct answer in `lang`. Japanese earns half of the English amount. */
export function takerPointsFor(extraHints: number, lang: AnswerLanguage): number {
  const english = pointsForHints(extraHints);
  return lang === "ja" ? Math.round(english * SCORING.JAPANESE_SHARE) : english;
}

/** The Giver's bonus: half of the points the Taker was awarded. */
export function giverPointsFor(takerPoints: number): number {
  return Math.round(takerPoints * SCORING.GIVER_SHARE);
}

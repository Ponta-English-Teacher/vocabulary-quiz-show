/**
 * PROVISIONAL scoring formula (easy to tune — change the numbers here only).
 *
 *   Taker points = max(FLOOR, BASE − PER_HINT × hintsUsed)
 *   Giver points = round(Taker points × GIVER_SHARE)
 *
 * With the defaults (BASE 100, PER_HINT 15, FLOOR 25, GIVER_SHARE 0.5):
 *
 *   hints used : 0    1   2   3   4   5+
 *   Taker      : 100  85  70  55  40  25
 *   Giver      : 50   43  35  28  20  13
 *
 * - "hintsUsed" counts prepared hints that were revealed PLUS any spoken hints
 *   the Giver added with the + button.
 * - A skipped word scores 0 for both players.
 * - Wrong guesses cost nothing (we want students to keep trying).
 */
export const SCORING = {
  BASE: 100,
  PER_HINT: 15,
  FLOOR: 25,
  GIVER_SHARE: 0.5,
} as const;

export function pointsForHints(hintsUsed: number): number {
  const hints = Math.max(0, Math.floor(hintsUsed));
  return Math.max(SCORING.FLOOR, SCORING.BASE - SCORING.PER_HINT * hints);
}

export function giverPointsFor(takerPoints: number): number {
  return Math.round(takerPoints * SCORING.GIVER_SHARE);
}

"use client";

import { pointsForHints } from "@/lib/scoring";
import { useCountUp } from "@/lib/hooks";

/** Live "this word is worth N points" readout that ticks down as hints are used. */
export function PointsMeter({ hintsUsed }: { hintsUsed: number }) {
  const worth = pointsForHints(hintsUsed);
  const shown = useCountUp(worth, 500);
  return (
    <div className="worth" aria-live="polite">
      <span className="worth__label">Worth</span>
      <span className="worth__value" aria-label={`${worth} points`}>{shown}</span>
      <span className="worth__label">pts</span>
    </div>
  );
}

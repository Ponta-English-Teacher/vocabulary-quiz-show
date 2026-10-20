"use client";

import { takerPointsFor } from "@/lib/scoring";
import { useCountUp } from "@/lib/hooks";

/**
 * Live "this word is worth N points" readout that ticks down as EXTRA hints are used (the opening hint is free).
 * `showJapanese` adds the half-value a correct Japanese answer would earn.
 */
export function PointsMeter({ hintsUsed, showJapanese = false }: { hintsUsed: number; showJapanese?: boolean }) {
  const english = takerPointsFor(hintsUsed, "en");
  const japanese = takerPointsFor(hintsUsed, "ja");
  const shown = useCountUp(english, 500);
  return (
    <div className="worth" aria-live="polite">
      <span className="worth__label">Worth</span>
      <span className="worth__value" aria-label={`${english} points for an English answer`}>{shown}</span>
      <span className="worth__label">pts</span>
      {showJapanese ? (
        <span className="worth__ja" aria-label={`${japanese} points for a Japanese answer`}>
          · <b>{japanese}</b> if answered in Japanese
        </span>
      ) : null}
    </div>
  );
}

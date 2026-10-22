"use client";

import { clampPlayCount } from "@/lib/playCount";

/** "Number of words to play": a whole number from 1 to the number of available words. */
export function PlayCount({ available, value, onChange, label = "Number of words to play" }: { available: number; value: number; onChange: (n: number) => void; label?: string }) {
  return (
    <label className="field playcount">
      <span className="field__label">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={available}
        step={1}
        value={value}
        onChange={(e) => onChange(clampPlayCount(e.target.value, available))}
        aria-describedby="playcount-note"
      />
      <span id="playcount-note" className="note">{available} available · playing {value}</span>
    </label>
  );
}

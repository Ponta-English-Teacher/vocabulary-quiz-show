"use client";

import { useState } from "react";

/** Two-step skip so a stray tap can't throw a word away. */
export function SkipButton({ onSkip }: { onSkip: () => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" className="btn btn--link" onClick={() => setArmed(true)}>
        Skip this word
      </button>
    );
  }
  return (
    <div className="skip-confirm" role="group" aria-label="Confirm skip">
      <span>Skip for 0 points?</span>
      <button type="button" className="btn btn--small" onClick={onSkip}>Yes, skip</button>
      <button type="button" className="btn btn--small btn--ghost" onClick={() => setArmed(false)}>Keep playing</button>
    </div>
  );
}

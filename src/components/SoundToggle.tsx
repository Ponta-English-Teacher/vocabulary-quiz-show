"use client";

import { useEffect, useState } from "react";
import { play, setMuted } from "@/lib/sound";

const KEY = "vqs-muted";

export function SoundToggle() {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) === "1";
      setMuted(saved);
      setMutedState(saved);
    } catch {
      /* storage unavailable — default to sound on */
    }
  }, []);

  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!next) play("tap");
  };

  return (
    <button
      type="button"
      className="sound-toggle"
      onClick={toggle}
      aria-pressed={muted}
      aria-label={muted ? "Sound is off. Turn sound on" : "Sound is on. Turn sound off"}
    >
      <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
    </button>
  );
}

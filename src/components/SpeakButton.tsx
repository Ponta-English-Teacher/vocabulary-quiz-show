"use client";

import type { ReactNode } from "react";
import { speakText } from "@/lib/speech";
import { useCanSpeak, useSpeaking } from "@/lib/useSpeech";

/**
 * Plays `text` aloud. Only one SpeakButton plays at a time (starting one stops the other);
 * pressing the button that is playing stops it.
 */
export function SpeakButton({
  text,
  id,
  rate,
  label,
  variant = "pill",
  ghost = false,
  children,
}: {
  text: string;
  id: string;
  rate?: number;
  /** What is being read, for screen readers: "the word", "hint 2". */
  label: string;
  variant?: "pill" | "icon";
  ghost?: boolean;
  children?: ReactNode;
}) {
  const can = useCanSpeak();
  const playing = useSpeaking(id);
  const onClick = () => void speakText(text, { id, rate });
  if (variant === "icon") {
    return (
      <button type="button" className={`speak-btn ${playing ? "is-on" : ""}`} disabled={!can} onClick={onClick} aria-pressed={playing} aria-label={`${playing ? "Stop" : "Hear"} ${label}`}>
        <span aria-hidden="true">{playing ? "⏹" : "🔊"}</span>
      </button>
    );
  }
  return (
    <button type="button" className={`btn btn--small btn--speak ${ghost ? "btn--ghost" : ""}`} disabled={!can} onClick={onClick} aria-pressed={playing}>
      {playing ? "⏹ Stop" : children}
    </button>
  );
}

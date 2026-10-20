"use client";

import { useEffect, useRef } from "react";
import type { GameState } from "@/lib/game";
import { play } from "@/lib/sound";

/**
 * Sound cues driven by state changes, played once per change regardless of which screen shows.
 * The first state a component sees is silent (so a refresh doesn't replay old sounds);
 * `null → game` (a game just started) plays the opening fanfare.
 */
export function useGameSounds(state: GameState | null): void {
  const prev = useRef<GameState | null | undefined>(undefined);
  useEffect(() => {
    const p = prev.current;
    prev.current = state;
    if (p === undefined || !state) return;
    if (p === null) {
      play("fanfare");
      return;
    }
    if (state.phase === "reveal" && p.phase !== "reveal") {
      play(state.lastResult?.outcome === "solved" ? "correct" : "skip");
    } else if (state.phase === "switch" && p.phase !== "switch" && p.phase !== "welcome") {
      play("switch");
    } else if (state.phase === "switch" && p.phase === "welcome") {
      play("fanfare");
    }
    if (state.feedback && state.feedback !== p.feedback) play(state.feedback.kind === "close" ? "close" : "wrong");
    if (state.phase === "round" && p.phase === "round" && state.hintsUsed > p.hintsUsed) play("hint");
  }, [state]);
}

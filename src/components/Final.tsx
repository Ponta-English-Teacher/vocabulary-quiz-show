"use client";

import { useEffect, useState } from "react";
import { getFinalResult, type GameState } from "@/lib/game";
import { useCountUp, usePrefersReducedMotion } from "@/lib/hooks";
import { play } from "@/lib/sound";
import { Confetti } from "./Confetti";
import { Bulbs } from "./Stage";

const SUSPENSE_MS = 2600;

export function Final({ state, onAgain }: { state: GameState; onAgain: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const result = getFinalResult(state.players);

  useEffect(() => {
    if (reduced) {
      setRevealed(true);
      return;
    }
    play("drumroll");
    const id = window.setTimeout(() => setRevealed(true), SUSPENSE_MS);
    return () => window.clearTimeout(id);
  }, [reduced]);

  useEffect(() => {
    if (revealed) play("fanfare");
  }, [revealed]);

  const s0 = useCountUp(revealed ? state.players[0].score : 0, 1400);
  const s1 = useCountUp(revealed ? state.players[1].score : 0, 1400);
  const shown = [s0, s1];

  if (!revealed) {
    return (
      <main className="screen final final--wait" aria-live="polite">
        <p className="eyebrow">Ten words later…</p>
        <h2 className="drumroll">And the winner is<span className="dots"><i>.</i><i>.</i><i>.</i></span></h2>
      </main>
    );
  }

  const winnerName = result.kind === "winner" ? state.players[result.winner].name : null;
  const solved = state.history.filter((h) => h.outcome === "solved").length;

  return (
    <main className="screen final" aria-live="polite">
      <Confetti count={110} />
      <p className="eyebrow">{winnerName ? "Tonight's champion" : "What a finish"}</p>
      <Bulbs />
      <h2 className="champion">{winnerName ?? "It's a tie!"}</h2>
      <Bulbs />
      {!winnerName ? <p className="tagline">Two champions share the stage.</p> : null}

      <div className="finalscores">
        {state.players.map((p, i) => (
          <div key={i} className={`finalscore ${result.kind === "winner" && result.winner === i ? "is-winner" : ""}`}>
            <span className="finalscore__name">{p.name}</span>
            <span className="finalscore__pts">{shown[i]}</span>
          </div>
        ))}
      </div>

      <p className="note">{solved} of {state.words.length} words solved</p>

      <ul className="recap">
        {state.history.map((h) => {
          const w = state.words.find((x) => x.id === h.wordId)!;
          return (
            <li key={h.wordId} className={h.outcome === "skipped" ? "is-skipped" : ""}>
              <span>{w.word}</span>
              <span>{h.outcome === "solved" ? `${state.players[h.taker].name} +${h.takerPoints}${h.answeredIn === "ja" ? " (JP)" : ""}` : "skipped"}</span>
            </li>
          );
        })}
      </ul>

      <button type="button" className="btn btn--hero" onClick={onAgain}>Play again</button>
    </main>
  );
}

"use client";

import { completedCount, type GameState } from "@/lib/game";
import { useCountUp } from "@/lib/hooks";

function Score({ value }: { value: number }) {
  const shown = useCountUp(value, 1100);
  return <span className="hud__score" aria-label={`${value} points`}>{shown}</span>;
}

/** Scoreboard + progress bulbs shown above every in-game screen. */
export function Hud({ state }: { state: GameState }) {
  const taker = state.giver === 0 ? 1 : 0;
  const inRound = state.phase === "round" || state.phase === "reveal" || state.phase === "board" || state.phase === "switch";
  const done = completedCount(state);

  return (
    <header className="hud">
      <div className="hud__players">
        {state.players.map((p, i) => {
          const role = i === state.giver ? "giver" : i === taker ? "taker" : null;
          return (
            <div key={i} className={`hud__player hud__player--${i === 0 ? "left" : "right"} ${inRound && role ? `is-${role}` : ""}`}>
              <span className="hud__name">{p.name}</span>
              <Score value={p.score} />
              {inRound && role ? <span className="hud__role">{role}</span> : null}
            </div>
          );
        })}
      </div>
      <div
        className="hud__progress"
        role="progressbar"
        aria-label="Words completed"
        aria-valuemin={0}
        aria-valuemax={state.words.length}
        aria-valuenow={done}
      >
        {state.words.map((w) => (
          <i key={w.id} className={`pip pip--${state.statuses[w.id]} ${w.id === state.currentWordId && state.phase === "round" ? "pip--live" : ""}`} />
        ))}
        <span className="hud__count">{done}/{state.words.length}</span>
      </div>
    </header>
  );
}

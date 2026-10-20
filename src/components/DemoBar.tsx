"use client";

import type { GameState } from "@/lib/game";

export type ViewRole = "giver" | "taker";

/**
 * DEMO MODE control. Lets one person flip between what the Giver's phone and the
 * Taker's phone would show. In the real product each phone shows only its own role.
 */
export function DemoBar({
  state,
  view,
  onView,
  onRestart,
}: {
  state: GameState;
  view: ViewRole;
  onView: (v: ViewRole) => void;
  onRestart: () => void;
}) {
  const giver = state.players[state.giver].name;
  const taker = state.players[state.giver === 0 ? 1 : 0].name;
  const showSwitch = state.phase === "round";

  return (
    <aside className="demobar" aria-label="Demo mode controls">
      <div className="demobar__top">
        <span className="demobar__badge">Demo mode</span>
        <span className="demobar__text">One screen · phones are not synced</span>
        <button type="button" className="demobar__restart" onClick={onRestart}>Restart</button>
      </div>
      {showSwitch ? (
        <div className="seg" role="group" aria-label="Preview as">
          <button type="button" aria-pressed={view === "giver"} onClick={() => onView("giver")}>
            Giver screen<small>{giver}</small>
          </button>
          <button type="button" aria-pressed={view === "taker"} onClick={() => onView("taker")}>
            Taker screen<small>{taker}</small>
          </button>
        </div>
      ) : null}
    </aside>
  );
}

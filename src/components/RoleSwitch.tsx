"use client";

import { Bulbs } from "./Stage";
import type { GameState } from "@/lib/game";

/** Dramatic role announcement. On a swap, the two names visibly cross over. */
export function RoleSwitch({ state, onContinue, you }: { state: GameState; onContinue: () => void; you?: "giver" | "taker" }) {
  const giver = state.players[state.giver];
  const taker = state.players[state.giver === 0 ? 1 : 0];
  const swap = state.switchKind === "swap";

  return (
    <main className="screen switch" aria-live="polite">
      <p className="eyebrow">{swap ? "Plot twist" : "Tonight's roles"}</p>
      <h2 className="switch__title">{swap ? <>Roles<br />switch!</> : <>Take<br />your places</>}</h2>
      <Bulbs count={10} />
      {you ? <p className={`switch__you switch__you--${you}`}>You are the {you}</p> : null}

      <div className={`switch__rows ${swap ? "is-swap" : "is-intro"}`}>
        <div className="switch__row switch__row--giver">
          <span className="role-tag role-tag--giver">Giver</span>
          <span className="switch__name">{giver.name}</span>
          <span className="switch__desc">sees the word &amp; explains it</span>
        </div>
        <div className="switch__row switch__row--taker">
          <span className="role-tag role-tag--taker">Taker</span>
          <span className="switch__name">{taker.name}</span>
          <span className="switch__desc">asks questions &amp; guesses</span>
        </div>
      </div>

      <button type="button" className="btn btn--hero switch__go" onClick={onContinue}>
        Choose a word
      </button>
    </main>
  );
}

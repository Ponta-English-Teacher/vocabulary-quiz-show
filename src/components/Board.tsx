"use client";

import type { GameState } from "@/lib/game";
import { redactForTaker } from "@/lib/game";
import { play } from "@/lib/sound";

/**
 * Word picker. Uses the Taker-safe view of the words, so even in demo mode
 * the unsolved words can't be read here — only number, topic and level.
 */
export function Board({ state, onPick, canPick = true }: { state: GameState; onPick: (id: string) => void; canPick?: boolean }) {
  const safe = redactForTaker(state);
  const giver = state.players[state.giver].name;

  return (
    <main className="screen board">
      <p className="eyebrow">Next up</p>
      <h2 className="screen__title">{canPick ? `${giver}, pick a word` : `${giver} is picking a word…`}</h2>
      <p className="note">{canPick ? "The word stays secret until it's solved." : "Ask your partner questions about the topic while you wait."}</p>

      <ol className="board__list">
        {safe.words.map((w, i) => {
          const status = state.statuses[w.id];
          const result = state.history.find((h) => h.wordId === w.id);
          const pending = status === "pending";
          return (
            <li key={w.id}>
              <button
                type="button"
                className={`card card--${status}`}
                disabled={!pending || !canPick}
                onClick={() => {
                  play("tap");
                  onPick(w.id);
                }}
                aria-label={
                  pending
                    ? `Word ${i + 1}, ${w.category}, level ${w.cefr}`
                    : `Word ${i + 1}, ${status}: ${w.word}`
                }
              >
                <span className="card__num">{i + 1}</span>
                <span className="card__body">
                  {pending ? (
                    <>
                      <span className="card__cat">{w.category}</span>
                      <span className="card__meta">{w.partOfSpeech} · {w.cefr}</span>
                    </>
                  ) : (
                    <>
                      <span className="card__word">{w.word}</span>
                      <span className="card__meta">{status === "solved" ? `solved · ${result?.takerPoints ?? 0} pts` : "skipped"}</span>
                    </>
                  )}
                </span>
                {pending ? <span className="card__go" aria-hidden="true">›</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </main>
  );
}

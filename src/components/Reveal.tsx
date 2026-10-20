"use client";

import { currentWord, remainingCount, type GameState } from "@/lib/game";
import { useCountUp } from "@/lib/hooks";
import { speechAvailable } from "@/lib/speech";
import { SpeakButton } from "./SpeakButton";
import { Confetti } from "./Confetti";

export function Reveal({ state, onNext }: { state: GameState; onNext: () => void }) {
  const word = currentWord(state);
  const result = state.lastResult;
  const takerPts = useCountUp(result?.takerPoints ?? 0, 1000);
  const giverPts = useCountUp(result?.giverPoints ?? 0, 1000);
  if (!word || !result) return null;

  const solved = result.outcome === "solved";
  const taker = state.players[result.taker].name;
  const giver = state.players[result.giver].name;
  const last = remainingCount(state) === 0;

  return (
    <main className={`screen reveal ${solved ? "reveal--win" : "reveal--skip"}`} aria-live="polite">
      {solved ? <Confetti /> : null}
      <p className="eyebrow">{solved ? "That's it!" : "No worries"}</p>
      <h2 className={solved ? "burst" : "burst burst--calm"}>{solved ? "Correct!" : "Skipped"}</h2>

      <p className="reveal__word">{word.word}</p>
      {speechAvailable() ? (
        <SpeakButton id="reveal" text={word.word} label="the word" ghost>🔊 Say it together</SpeakButton>
      ) : null}
      <p className="reveal__meaning">{word.meaning}</p>
      <p className="reveal__eg">“{word.example}”</p>

      {solved ? (
        <dl className="awards">
          <div>
            <dt>{taker}</dt>
            <dd className="c-cyan">+{takerPts}</dd>
          </div>
          <div>
            <dt>{giver}</dt>
            <dd className="c-gold">+{giverPts}</dd>
          </div>
        </dl>
      ) : null}
      <p className="note">
        {solved
          ? `${result.hintsUsed} hint${result.hintsUsed === 1 ? "" : "s"} · ${result.wrongGuesses} miss${result.wrongGuesses === 1 ? "" : "es"}`
          : "Say the word and its meaning together, then move on."}
      </p>

      <button type="button" className="btn btn--hero" onClick={onNext}>
        {last ? "See the results" : "Next word"}
      </button>
    </main>
  );
}

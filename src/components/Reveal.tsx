"use client";

import { currentWord, remainingCount, type GameState } from "@/lib/game";
import { useCountUp } from "@/lib/hooks";
import { japaneseDisplay } from "@/lib/japanese";
import { RATES, speechAvailable } from "@/lib/speech";
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
  const inJapanese = solved && result.answeredIn === "ja";
  const japanese = japaneseDisplay(word.ja);

  return (
    <main className={`screen reveal ${solved ? "reveal--win" : "reveal--skip"}`} aria-live="polite">
      {solved ? <Confetti /> : null}
      <p className="eyebrow">{solved ? "That's it!" : "No worries"}</p>
      <h2 className={solved ? "burst" : "burst burst--calm"}>{solved ? "Correct!" : "Skipped"}</h2>
      {inJapanese ? <p className="reveal__lang">You answered in Japanese — half points. Now learn the English word:</p> : null}

      <p className="reveal__word">{word.word}</p>
      {japanese ? <p className="reveal__ja" lang="ja"><span>日本語</span> {japanese}</p> : null}
      {speechAvailable() ? (
        <div className="row">
          <SpeakButton id="reveal" text={word.word} rate={RATES.word} label="the word" ghost>🔊 Listen</SpeakButton>
          <SpeakButton id="reveal-slow" text={word.word} rate={RATES.slow} label="the word, slowly" ghost>🐢 Slowly</SpeakButton>
        </div>
      ) : null}
      <p className="reveal__repeat">{solved ? "Say it out loud in English before you move on!" : "Say the word out loud together."}</p>
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
          ? `${result.hintsUsed} extra hint${result.hintsUsed === 1 ? "" : "s"} · ${result.wrongGuesses} miss${result.wrongGuesses === 1 ? "" : "es"}${inJapanese ? " · Japanese answer" : ""}`
          : "Talk about what it means, then move on."}
      </p>

      <button type="button" className="btn btn--hero" onClick={onNext}>
        {last ? "See the results" : "Next word"}
      </button>
    </main>
  );
}

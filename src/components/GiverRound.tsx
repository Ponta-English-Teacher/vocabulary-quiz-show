"use client";

import { useEffect } from "react";
import { currentWord, type GameAction, type GameState } from "@/lib/game";
import { RATES, stopSpeaking } from "@/lib/speech";
import { useCanSpeak } from "@/lib/useSpeech";
import { SpeakButton } from "./SpeakButton";
import { PointsMeter } from "./PointsMeter";
import { SkipButton } from "./SkipButton";

export function GiverRound({ state, dispatch }: { state: GameState; dispatch: (a: GameAction) => void }) {
  const word = currentWord(state);
  const canSpeak = useCanSpeak();
  // Stop any playback when this screen goes away (new word, role switch, leaving).
  useEffect(() => stopSpeaking, []);
  if (!word) return null;

  const giver = state.players[state.giver].name;
  const spoken = state.hintsUsed - state.revealedHints;
  const fb = state.feedback;

  return (
    <main className="screen round round--giver">
      <p className="eyebrow">{giver} · you are the <b className="c-gold">Giver</b></p>

      <section className="spot" aria-label="Secret word">
        <p className="spot__cat">{word.category} · {word.partOfSpeech} · {word.cefr}</p>
        <h2 className="secret-word">{word.word}</h2>
        <p className="spelling" aria-label={`Spelled ${word.word.split("").join(" ")}`}>
          {word.word.split("").map((ch, i) => (
            <span key={i} aria-hidden="true">{ch}</span>
          ))}
        </p>
        <div className="row">
          <SpeakButton id="word" text={word.word} rate={RATES.word} label="the word">🔊 Hear it</SpeakButton>
          <SpeakButton id="word-slow" text={word.word} rate={RATES.slow} label="the word, slowly" ghost>🐢 Slowly</SpeakButton>
        </div>
        {!canSpeak ? <p className="note">Pronunciation isn&apos;t available in this browser.</p> : null}
      </section>

      <section className="meaning">
        <h3 className="label">Meaning</h3>
        <p className="meaning__text">{word.meaning}</p>
        <p className="meaning__eg">“{word.example}”</p>
        <p className="note">Explain it in your own words. Don&apos;t say or spell the word!</p>
      </section>

      <section className="hints" aria-label="Hints">
        <div className="hints__head">
          <h3 className="label">Hints given</h3>
          <PointsMeter hintsUsed={state.hintsUsed} />
        </div>

        <div className="counter">
          <button
            type="button"
            className="counter__btn"
            aria-label="Remove one spoken hint"
            disabled={spoken <= 0}
            onClick={() => dispatch({ type: "ADJUST_HINTS", delta: -1 })}
          >
            −
          </button>
          <div className="counter__value" aria-live="polite">
            <b>{state.hintsUsed}</b>
            <span>{spoken > 0 ? `${state.revealedHints} prepared + ${spoken} spoken` : "hints used"}</span>
          </div>
          <button
            type="button"
            className="counter__btn counter__btn--plus"
            aria-label="Add one spoken hint"
            onClick={() => dispatch({ type: "ADJUST_HINTS", delta: 1 })}
          >
            +
          </button>
        </div>
        <p className="note">Gave your own spoken clue? Tap + to count it.</p>

        <ol className="ladder">
          {word.hints.map((h, i) => {
            const shown = i < state.revealedHints;
            const next = i === state.revealedHints;
            return (
              <li key={i} className={shown ? "is-shown" : ""}>
                <span className="ladder__n">{i + 1}</span>
                {shown ? (
                  <>
                    <span className="ladder__text">{h}</span>
                    <SpeakButton id={`hint-${i}`} text={h} rate={RATES.hint} label={`hint ${i + 1}`} variant="icon" />
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    disabled={!next}
                    onClick={() => dispatch({ type: "REVEAL_HINT" })}
                  >
                    {next ? "Reveal prepared hint" : "Locked"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <p className="taker-watch" aria-live="polite">
        {fb
          ? <>Taker tried “{fb.guess}” — {fb.kind === "close" ? "so close!" : "not yet."}</>
          : <>Waiting for {state.players[state.giver === 0 ? 1 : 0].name}&apos;s guess…</>}
      </p>

      <SkipButton onSkip={() => dispatch({ type: "SKIP" })} />
    </main>
  );
}

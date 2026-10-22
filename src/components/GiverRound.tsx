"use client";

import { useEffect } from "react";
import { currentWord, paidRevealedHints, spokenHints, type GameAction, type GameState } from "@/lib/game";
import { giverNotesFor } from "@/lib/giverNotes";
import { RATES, stopSpeaking } from "@/lib/speech";
import { SCORING } from "@/lib/scoring";
import { useCanSpeak } from "@/lib/useSpeech";
import { SpeakButton } from "./SpeakButton";
import { PointsMeter } from "./PointsMeter";
import { SkipButton } from "./SkipButton";
import { GiverPicture, IllustrationRequest, type RequestResult } from "./IllustrationHint";

export function GiverRound({
  state,
  dispatch,
  onRequestIllustration,
}: {
  state: GameState;
  dispatch: (a: GameAction) => void;
  /** Asks for the illustration of the word in play. Classroom: the server decides, draws and applies the score cap. */
  onRequestIllustration?: () => Promise<RequestResult>;
}) {
  const word = currentWord(state);
  const canSpeak = useCanSpeak();
  // Stop any playback when this screen goes away (new word, role switch, leaving).
  useEffect(() => stopSpeaking, []);
  if (!word) return null;

  const giver = state.players[state.giver].name;
  const spoken = spokenHints(state);
  const paid = paidRevealedHints(state);
  const fb = state.feedback;
  const notes = giverNotesFor(word);
  const opening = word.hints[0];
  const nextHint = state.revealedHints; // index of the next hint to reveal (the first paid one is index 1)

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

      {opening ? (
        <section className="clues" aria-label="Opening hint">
          <p className="clue clue--opening">
            <span className="clue__tag">Opening hint · free · {state.players[state.giver === 0 ? 1 : 0].name} can see it</span>
            <span className="clue__text">{opening}</span>
          </p>
          <p className="note">Start from here. Your partner asks questions — answer them in English. Talking is always free.</p>
        </section>
      ) : null}

      <GiverPicture used={state.illustrationUsed} illustration={word.illustration} />

      <section className="meaning">
        <h3 className="label">Meaning</h3>
        <p className="meaning__text">{word.meaning}</p>
        <p className="meaning__eg">“{word.example}”</p>
      </section>

      <section className="giver-help" aria-label="Help for explaining">
        <h3 className="label">Help for explaining</h3>
        {notes.looks ? (
          <p className="giver-help__row"><b>{notes.looksLabel}</b><span>{notes.looks}</span></p>
        ) : null}
        {notes.use ? (
          <p className="giver-help__row"><b>{notes.useLabel}</b><span>{notes.use}</span></p>
        ) : null}
        <div className="giver-help__row giver-help__row--phrases">
          <b>Useful language</b>
          <ul className="phrases">
            {notes.phrases.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
        <p className="note">
          This is support, not a script — answer your partner&apos;s questions in your own words. Don&apos;t say or spell the word!
        </p>
      </section>

      <section className="hints" aria-label="Hints">
        <div className="hints__head">
          <h3 className="label">Extra hints</h3>
          <PointsMeter hintsUsed={state.hintsUsed} illustration={state.illustrationUsed} />
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
            <span>{spoken > 0 ? `${paid} prepared + ${spoken} spoken` : "extra hints used"}</span>
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
        <p className="note">Gave an extra clue of your own, beyond answering questions? Tap + to count it. The opening hint and ordinary answers are free.</p>

        <ol className="ladder">
          {word.hints.map((h, i) => {
            const shown = i < state.revealedHints;
            const next = i === nextHint;
            return (
              <li key={i} className={shown ? "is-shown" : ""}>
                <span className="ladder__n">{i + 1}</span>
                {shown ? (
                  <>
                    <span className="ladder__text">{h}{i === 0 ? <em className="ladder__free"> (opening · free)</em> : null}</span>
                    <SpeakButton id={`hint-${i}`} text={h} rate={RATES.hint} label={`hint ${i + 1}`} variant="icon" />
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    disabled={!next}
                    onClick={() => dispatch({ type: "REVEAL_HINT" })}
                  >
                    {next ? `Reveal extra hint (−${SCORING.PER_HINT} pts)` : "Locked"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {!state.illustrationUsed && onRequestIllustration ? <IllustrationRequest onRequest={onRequestIllustration} /> : null}

      <p className="taker-watch" aria-live="polite">
        {fb && (fb.kind === "wrong" || fb.kind === "close")
          ? <>Taker tried{fb.lang === "ja" ? " in Japanese" : ""} “{fb.guess}” — {fb.kind === "close" ? "so close!" : "not yet."}</>
          : fb && fb.lang === "ja"
            ? <>Taker tried a Japanese answer — it can&apos;t score for this word.</>
            : <>Waiting for {state.players[state.giver === 0 ? 1 : 0].name}&apos;s guess…</>}
      </p>

      <SkipButton onSkip={() => dispatch({ type: "SKIP" })} />
    </main>
  );
}

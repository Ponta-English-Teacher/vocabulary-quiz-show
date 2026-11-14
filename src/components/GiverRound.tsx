"use client";

import { useEffect } from "react";
import { currentWord, paidRevealedHints, spokenHints, type GameAction, type GameState } from "@/lib/game";
import { giverNotesFor } from "@/lib/giverNotes";
import { RATES, stopSpeaking } from "@/lib/speech";
import { FREE_HINTS, SCORING } from "@/lib/scoring";
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

  const taker = state.players[state.giver === 0 ? 1 : 0].name;
  const hasLaterHints = word.hints.length > FREE_HINTS;

  return (
    <main className="screen round round--giver">
      <p className="eyebrow">{giver} · you are the <b className="c-gold">Giver</b></p>

      <section className="spot spot--compact" aria-label="Secret word">
        <p className="spot__cat">{word.category} · {word.partOfSpeech} · {word.cefr}</p>
        <h2 className="secret-word">{word.word}</h2>
        <div className="row">
          <SpeakButton id="word" text={word.word} rate={RATES.word} label="the word">🔊 Hear it</SpeakButton>
          <SpeakButton id="word-slow" text={word.word} rate={RATES.slow} label="the word, slowly" ghost>🐢 Slowly</SpeakButton>
        </div>
        {!canSpeak ? <p className="note">Pronunciation isn&apos;t available in this browser.</p> : null}
      </section>

      <p className="rule-banner" role="note">
        <b>Explain the word in English.</b> Don&apos;t say or spell the word.
      </p>

      {opening ? (
        <section className="clues" aria-label="Opening hint">
          <p className="clue clue--opening">
            <span className="clue__tag">Opening hint · free · say it aloud</span>
            <span className="clue__text">{opening}</span>
          </p>
        </section>
      ) : null}

      <section className="hints" aria-label="Hints">
        <div className="hints__head">
          <h3 className="label">Hints for {taker}</h3>
          <PointsMeter hintsUsed={state.hintsUsed} illustration={state.illustrationUsed} />
        </div>

        {hasLaterHints ? (
          <ol className="ladder">
            {word.hints.map((h, i) => {
              if (i < FREE_HINTS) return null; // the opening hint is shown once, above
              const shown = i < state.revealedHints;
              const next = i === nextHint;
              if (!shown && !next) return null; // later hints stay out of sight until it is their turn
              return (
                <li key={i} className={shown ? "is-shown" : ""}>
                  {shown ? (
                    <>
                      <span className="ladder__n">{i}</span>
                      <span className="ladder__text">{h}</span>
                      <SpeakButton id={`hint-${i}`} text={h} rate={RATES.hint} label={`hint ${i + 1}`} variant="icon" />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--hero btn--reveal"
                      onClick={() => dispatch({ type: "REVEAL_HINT" })}
                    >
                      Reveal Next Hint (−{SCORING.PER_HINT} points)
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        ) : null}
        {hasLaterHints && nextHint >= word.hints.length ? <p className="note">All prepared hints are used.</p> : null}
        {hasLaterHints ? <p className="note">Say each hint aloud first. {taker}&apos;s screen shows a hint only after you reveal the next one.</p> : null}

        <div className="owncount">
          <button
            type="button"
            className="btn btn--own"
            aria-label="I gave my own extra hint (adds one to the count)"
            onClick={() => dispatch({ type: "ADJUST_HINTS", delta: 1 })}
          >
            <span className="btn--own__plus" aria-hidden="true">+</span> I gave my own extra hint
          </button>
          <div className="owncount__row" aria-live="polite">
            <span>
              Your own hints: <b>{spoken}</b> · Extra hints used: <b>{state.hintsUsed}</b>
              {paid > 0 ? <> ({paid} revealed)</> : null}
            </span>
            <button
              type="button"
              className="btn btn--small btn--ghost owncount__undo"
              aria-label="Undo one of my own extra hints (removes one from the count)"
              disabled={spoken <= 0}
              onClick={() => dispatch({ type: "ADJUST_HINTS", delta: -1 })}
            >
              − Undo
            </button>
          </div>
          <p className="note">Press + every time you give a clue of your own. Each extra hint costs {SCORING.PER_HINT} points. Answering questions is free.</p>
        </div>
      </section>

      <GiverPicture used={state.illustrationUsed} illustration={word.illustration} />

      {!state.illustrationUsed && onRequestIllustration ? <IllustrationRequest onRequest={onRequestIllustration} /> : null}

      {word.meaning || word.example || word.giverJa ? (
        <details className="fold">
          <summary>{word.giverJa ? "Meaning and Japanese" : "Meaning and example"}</summary>
          {word.giverJa ? <p className="meaning__ja" lang="ja">日本語: {word.giverJa} <span className="note">(only you can see this)</span></p> : null}
          {word.meaning ? <p className="meaning__text">{word.meaning}</p> : null}
          {word.example ? <p className="meaning__eg">“{word.example}”</p> : null}
        </details>
      ) : null}

      <details className="fold">
        <summary>Words that help you explain</summary>
        <div className="giver-help" aria-label="Help for explaining">
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
          <p className="note">This is support, not a script. Don&apos;t say or spell the word!</p>
        </div>
      </details>

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

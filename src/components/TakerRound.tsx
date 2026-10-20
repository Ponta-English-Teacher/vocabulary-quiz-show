"use client";

import { useEffect, useRef, useState } from "react";
import { currentWord, type GameAction, type GameState } from "@/lib/game";
import { PointsMeter } from "./PointsMeter";
import { useDictation } from "./useDictation";
import { SkipButton } from "./SkipButton";

const QUESTION_STARTERS = [
  "Is it a thing, an action, or a feeling?",
  "Where can you find it?",
  "Can you give me an example sentence?",
  "What letter does it start with?",
  "Is it something you use every day?",
  "Does it have a similar word, or an opposite?",
  "How many syllables does it have?",
  "Can you act it out?",
];

/** Receives a REDACTED state (see redactForTaker) — it never holds the answer. */
export function TakerRound({ state, dispatch }: { state: GameState; dispatch: (a: GameAction) => void }) {
  const word = currentWord(state);
  const [text, setText] = useState("");
  const [tip, setTip] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fb = state.feedback;
  // Voice input fills the box with what was heard. The student can edit it; only "Lock it in" submits.
  const mic = useDictation((heard) => setText(heard));

  // Wrong guess: clear the box. Close guess: keep it so they can fix the spelling.
  useEffect(() => {
    if (fb?.kind === "wrong") setText("");
    if (fb) inputRef.current?.focus();
  }, [fb]);

  if (!word) return null;
  const taker = state.players[state.giver === 0 ? 1 : 0].name;

  return (
    <main className="screen round round--taker">
      <p className="eyebrow">{taker} · you are the <b className="c-cyan">Taker</b></p>

      <section className="spot spot--mystery" aria-label="Mystery word">
        <p className="spot__cat">{word.category} · {word.partOfSpeech} · {word.cefr}</p>
        <h2 className="mystery" aria-label="Mystery word, hidden">
          <span>?</span><span>?</span><span>?</span><span>?</span><span>?</span>
        </h2>
        <PointsMeter hintsUsed={state.hintsUsed} />
        <p className="note">{state.hintsUsed === 0 ? "No hints used yet." : `${state.hintsUsed} hint${state.hintsUsed === 1 ? "" : "s"} used`}</p>
      </section>

      <section className="ask">
        <h3 className="label">Ask your partner — out loud!</h3>
        <button type="button" className="ask__prompt" onClick={() => setTip((t) => (t + 1) % QUESTION_STARTERS.length)}>
          “{QUESTION_STARTERS[tip]}”
          <span className="ask__more">tap for another idea</span>
        </button>
      </section>

      <form
        className="answer"
        onSubmit={(e) => {
          e.preventDefault();
          mic.abort();
          dispatch({ type: "GUESS", text });
        }}
      >
        <label className="field field--answer" htmlFor="answer">
          <span className="field__label">Your answer</span>
        </label>
        <div key={fb?.n ?? 0} className={`answer__box ${fb ? `is-${fb.kind}` : ""}`}>
          <input
            id="answer"
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type, or tap 🎤 on your keyboard"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <button
            type="button"
            className={`mic-btn ${mic.listening ? "is-on" : ""}`}
            onClick={() => {
              mic.toggle();
              inputRef.current?.focus({ preventScroll: true });
            }}
            aria-pressed={mic.listening}
            aria-label={mic.listening ? "Stop listening" : "Speak your answer"}
            title={mic.listening ? "Tap to stop" : "Tap, then say your answer"}
          >
            <span aria-hidden="true">{mic.listening ? "⏹" : "🎤"}</span>
          </button>
          <button type="submit" className="btn btn--hero btn--inline" disabled={!text.trim()}>
            Lock it in
          </button>
        </div>
        <p className={`feedback ${fb ? `feedback--${fb.kind}` : ""}`} role="status" aria-live="polite">
          {fb?.kind === "wrong" ? "Not quite — keep asking questions!" : null}
          {fb?.kind === "close" ? "So close! Check the spelling and try again." : null}
        </p>
        <p className="dictation-note" role="status" aria-live="polite">
          {mic.listening ? "Listening… say your answer, then check the words below and press Lock it in." : mic.message}
        </p>
        <p className="note">Prefer to type? Typing always works — and your keyboard&apos;s own microphone key also dictates.</p>
      </form>

      <SkipButton onSkip={() => dispatch({ type: "SKIP" })} />
    </main>
  );
}

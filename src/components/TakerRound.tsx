"use client";

import { useEffect, useRef, useState } from "react";
import { currentWord, type Feedback, type GameAction, type GameState } from "@/lib/game";
import { questionsFor } from "@/lib/askQuestions";
import { FREE_HINTS, takerPointsFor } from "@/lib/scoring";
import { PointsMeter } from "./PointsMeter";
import { SkipButton } from "./SkipButton";


/** The message under an answer box. Each box shows only feedback about its own language. */
function feedbackText(fb: Feedback | null, lang: Feedback["lang"]): string | null {
  if (!fb || fb.lang !== lang) return null;
  switch (fb.kind) {
    case "wrong":
      return lang === "ja" ? "That isn't the Japanese word we're looking for — keep asking questions, or try again." : "Not quite — keep asking questions!";
    case "close":
      return "So close! Check the spelling and try again.";
    case "not-japanese":
      return "Please type your answer in Japanese in this box. (To answer in English, go back.)";
    case "no-ja-credit":
      return "This word has no approved Japanese answer, so it can't earn points in Japanese. Keep asking questions, or answer in English.";
  }
}

/** Receives a REDACTED state (see redactForTaker) — it never holds the answer, the Japanese answers or the unrevealed hints. */
export function TakerRound({ state, dispatch }: { state: GameState; dispatch: (a: GameAction) => void }) {
  const word = currentWord(state);
  const [text, setText] = useState("");
  const [jaText, setJaText] = useState("");
  // Which answer box is open. English is the default; the Japanese box opens only from the "not in English" button.
  const [mode, setMode] = useState<"en" | "ja">("en");
  const [tip, setTip] = useState(0);
  const questions = questionsFor(word ?? { partOfSpeech: "noun" });
  const inputRef = useRef<HTMLInputElement>(null);
  const jaInputRef = useRef<HTMLInputElement>(null);
  const fb = state.feedback;

  // Wrong guess: clear that box. Close guess: keep it so they can fix the spelling.
  useEffect(() => {
    if (!fb) return;
    if (fb.lang === "en") {
      if (fb.kind === "wrong") setText("");
      inputRef.current?.focus();
    } else {
      if (fb.kind === "wrong") setJaText("");
      jaInputRef.current?.focus();
    }
  }, [fb]);

  if (!word) return null;
  const taker = state.players[state.giver === 0 ? 1 : 0].name;
  // Only the EXTRA hints the Giver chose to reveal. The opening hint is the Giver's alone (the server never sends it here).
  const shownHints = word.hints.map((h, n) => ({ h, n })).filter((x) => x.n >= FREE_HINTS && x.n < state.revealedHints && x.h);
  const hasJapanese = (word.ja ?? []).length > 0; // the Taker only learns THAT a Japanese answer exists, never what it is
  const jaPoints = takerPointsFor(state.hintsUsed, "ja", state.illustrationUsed);

  const openJapanese = () => {
    setMode("ja");
    window.setTimeout(() => jaInputRef.current?.focus({ preventScroll: true }), 0);
  };
  const backToEnglish = () => {
    setMode("en");
  };

  return (
    <main className="screen round round--taker">
      <p className="eyebrow">{taker} · you are the <b className="c-cyan">Taker</b></p>

      <section className="spot spot--mystery" aria-label="Mystery word">
        <p className="spot__cat">{word.category} · {word.partOfSpeech} · {word.cefr}</p>
        <h2 className="mystery" aria-label="Mystery word, hidden">
          <span>?</span><span>?</span><span>?</span><span>?</span><span>?</span>
        </h2>
        <PointsMeter hintsUsed={state.hintsUsed} showJapanese={hasJapanese} illustration={state.illustrationUsed} />
        <p className="note">
          {state.hintsUsed === 0 ? "Questions are free — ask as many as you like." : `${state.hintsUsed} extra hint${state.hintsUsed === 1 ? "" : "s"} used`}
        </p>
      </section>

      {shownHints.length > 0 ? (
        <section className="clues" aria-label="Hints" aria-live="polite">
          {shownHints.map(({ h, n }) => (
            <p key={n} className="clue">
              <span className="clue__tag">{`Extra hint ${n}`}</span>
              <span className="clue__text">{h}</span>
            </p>
          ))}
        </section>
      ) : null}

      <section className="ask">
        <h3 className="label">Ask your partner — out loud!</h3>
        <p className="note ask__task">Ask your partner questions to find out the word.</p>
        <button type="button" className="ask__prompt" onClick={() => setTip((t) => (t + 1) % questions.length)}>
          “{questions[tip % questions.length]}”
          <span className="ask__more">tap for another idea</span>
        </button>
      </section>

      {mode === "en" ? (
        <>
          <form
            className="answer"
            onSubmit={(e) => {
              e.preventDefault();
              dispatch({ type: "GUESS", text });
            }}
          >
            <label className="field field--answer" htmlFor="answer">
              <span className="field__label">Your answer in English</span>
            </label>
            <div key={fb?.lang === "en" ? fb.n : 0} className={`answer__box ${fb?.lang === "en" ? `is-${fb.kind}` : ""}`}>
              <input
                id="answer"
                ref={inputRef}
                lang="en"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type your answer here"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
              />
              <button type="submit" className="btn btn--hero btn--inline" disabled={!text.trim()}>
                Lock it in
              </button>
            </div>
            <p className={`feedback ${fb?.lang === "en" ? `feedback--${fb.kind}` : ""}`} role="status" aria-live="polite">
              {feedbackText(fb, "en")}
            </p>
            <p className="note">Type your answer. (Your phone keyboard&apos;s own microphone key works too, if it has one.)</p>
          </form>

          <div className="notenglish">
            <button type="button" className="btn btn--ja" onClick={openJapanese}>
              I know it, but not in English!
            </button>
            <p className="note">Answer in Japanese for half the points.</p>
          </div>
        </>
      ) : (
        <form
          className="answer answer--ja"
          lang="ja"
          onSubmit={(e) => {
            e.preventDefault();
            dispatch({ type: "GUESS_JA", text: jaText });
          }}
        >
          <label className="field field--answer" htmlFor="answer-ja">
            <span className="field__label">日本語で答える · Answer in Japanese</span>
          </label>
          <p className="note">
            {hasJapanese
              ? `A correct Japanese answer earns ${jaPoints} points (half) and ends the round. You'll then learn the English word.`
              : "This word has no approved Japanese answer, so Japanese can't earn points. Keep asking questions, or go back and answer in English."}
          </p>
          <div key={fb?.lang === "ja" ? fb.n : 0} className={`answer__box ${fb?.lang === "ja" ? `is-${fb.kind === "wrong" ? "wrong" : "close"}` : ""}`}>
            <input
              id="answer-ja"
              ref={jaInputRef}
              lang="ja"
              value={jaText}
              onChange={(e) => setJaText(e.target.value)}
              placeholder="ここに日本語で入力"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
            />
            <button type="submit" className="btn btn--hero btn--inline" disabled={!jaText.trim() || !hasJapanese}>
              答えを送る
            </button>
          </div>
          <p className="feedback feedback--wrong" role="status" aria-live="polite">{feedbackText(fb, "ja")}</p>
          <button type="button" className="btn btn--link" onClick={backToEnglish}>← Back to the English answer</button>
        </form>
      )}

      <SkipButton onSkip={() => dispatch({ type: "SKIP" })} />
    </main>
  );
}

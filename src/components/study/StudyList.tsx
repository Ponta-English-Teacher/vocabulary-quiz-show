"use client";

import { useState } from "react";
import { SpeakButton } from "../SpeakButton";
import type { StudyWord } from "@/lib/study/types";

/**
 * The Japanese line of one study card. Japanese always starts HIDDEN: the student sees a "Show Japanese" button, taps it to reveal
 * that one word, and can hide it again. A word that genuinely has no Japanese says so (in both states) instead of looking empty.
 */
export function StudyJapanese({ ja, hidden, onShow, onHide, pending = false }: { ja: string[]; hidden: boolean; onShow?: () => void; onHide?: () => void; pending?: boolean }) {
  if (!ja.length) {
    return (
      <p className="study__ja study__ja--missing" lang="en">
        <span className="study__label">日本語</span> <em>{pending ? "Japanese is being prepared — check again in a moment" : "Japanese not added yet"}</em>
      </p>
    );
  }
  if (hidden) {
    return (
      <p className="study__ja">
        <span className="study__label">日本語</span>{" "}
        <button type="button" className="btn btn--small btn--ghost" onClick={onShow}>Show Japanese</button>
      </p>
    );
  }
  return (
    <p className="study__ja">
      <span className="study__label">日本語</span> <span lang="ja">{ja.join(" / ")}</span>{" "}
      <button type="button" className="btn btn--small btn--ghost" onClick={onHide}>Hide Japanese</button>
    </p>
  );
}

/** The student study list: every word with its definition, example and pronunciation; Japanese only when the student asks for it. */
export function StudyList({ title, words, back, pending = false }: { title: string; words: StudyWord[]; back?: { href: string; label: string }; pending?: boolean }) {
  // Nothing is revealed on load, and nothing is remembered: refreshing the page hides every translation again.
  const [shown, setShown] = useState<Set<number>>(new Set());
  const missing = words.filter((w) => !w.ja.length).length;
  const flip = (i: number, on: boolean) =>
    setShown((s) => {
      const next = new Set(s);
      if (on) next.add(i);
      else next.delete(i);
      return next;
    });
  return (
    <main className="study">
      <header className="study__head">
        {back ? <p><a className="btn btn--link" href={back.href}>‹ {back.label}</a></p> : null}
        <p className="eyebrow eyebrow--left">Study page</p>
        <h1 className="study__title">{title}</h1>
        <p className="note">{words.length} word{words.length === 1 ? "" : "s"} · Read at your own pace. Press 🔊 to hear a word. Try to remember the Japanese before you tap Show Japanese.</p>
        <p className="study__all">
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setShown(new Set(words.map((_, i) => i)))}>Show All Japanese</button>{" "}
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setShown(new Set())}>Hide All Japanese</button>
        </p>
        {missing > 0 ? (
          <p className="note" role="status">{pending ? "Japanese is being prepared for some words. Reload in a moment." : `Japanese isn't available yet for ${missing} word${missing === 1 ? "" : "s"}. Ask your teacher.`}</p>
        ) : null}
      </header>
      <ol className="study__list">
        {words.map((w, i) => (
          <li key={`${w.word}-${i}`} className="study__card">
            <div className="study__word">
              <h2>{w.word}</h2>
              <SpeakButton text={w.word} id={`study-word-${i}`} label={`the word ${w.word}`} variant="icon" />
              <span className="study__pos">{w.partOfSpeech}</span>
            </div>
            <p className="study__def">{w.meaning}</p>
            <StudyJapanese ja={w.ja} hidden={!shown.has(i)} onShow={() => flip(i, true)} onHide={() => flip(i, false)} pending={pending} />
            {w.example ? (
              <p className="study__ex">
                <SpeakButton text={w.example} id={`study-ex-${i}`} label={`the example for ${w.word}`} variant="icon" /> {w.example}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </main>
  );
}

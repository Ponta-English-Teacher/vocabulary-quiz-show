"use client";

import { useState } from "react";
import { SpeakButton } from "../SpeakButton";
import type { StudyWord } from "@/lib/study/types";

/**
 * The Japanese line of one study card. `hidden` is the recall-practice mode: the student sees a button instead and taps to
 * reveal that one word. A word that genuinely has no Japanese on file says so, in both modes, rather than looking empty.
 */
export function StudyJapanese({ ja, hidden, onReveal }: { ja: string[]; hidden: boolean; onReveal?: () => void }) {
  if (!ja.length) {
    return (
      <p className="study__ja study__ja--missing" lang="en">
        <span className="study__label">日本語</span> <em>Japanese not added yet</em>
      </p>
    );
  }
  if (hidden) {
    return (
      <p className="study__ja">
        <span className="study__label">日本語</span>{" "}
        <button type="button" className="btn btn--small btn--ghost" onClick={onReveal}>Show Japanese</button>
      </p>
    );
  }
  return (
    <p className="study__ja" lang="ja">
      <span className="study__label">日本語</span> {ja.join(" / ")}
    </p>
  );
}

/** The student study list: every word with its definition, Japanese meaning, example and a pronunciation button. */
export function StudyList({ title, words, back }: { title: string; words: StudyWord[]; back?: { href: string; label: string } }) {
  const [hideJa, setHideJa] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const missing = words.filter((w) => !w.ja.length).length;
  return (
    <main className="study">
      <header className="study__head">
        {back ? <p><a className="btn btn--link" href={back.href}>‹ {back.label}</a></p> : null}
        <p className="eyebrow eyebrow--left">Study page</p>
        <h1 className="study__title">{title}</h1>
        <p className="note">{words.length} word{words.length === 1 ? "" : "s"} · Read at your own pace. Press 🔊 to hear a word.</p>
        <p>
          <button
            type="button"
            className="btn btn--small btn--ghost"
            aria-pressed={hideJa}
            onClick={() => { setHideJa((v) => !v); setRevealed(new Set()); }}
          >
            {hideJa ? "Show all Japanese" : "Hide Japanese"}
          </button>
        </p>
        {missing > 0 ? <p className="note" role="status">Japanese isn&apos;t added yet for {missing} word{missing === 1 ? "" : "s"}. Ask your teacher.</p> : null}
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
            <StudyJapanese ja={w.ja} hidden={hideJa && !revealed.has(i)} onReveal={() => setRevealed((r) => new Set(r).add(i))} />
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

import { SpeakButton } from "../SpeakButton";
import type { StudyWord } from "@/lib/study/types";

/** The student study list: every word with its definition, Japanese meaning, example and a pronunciation button. */
export function StudyList({ title, words, back }: { title: string; words: StudyWord[]; back?: { href: string; label: string } }) {
  return (
    <main className="study">
      <header className="study__head">
        {back ? <p><a className="btn btn--link" href={back.href}>‹ {back.label}</a></p> : null}
        <p className="eyebrow eyebrow--left">Study page</p>
        <h1 className="study__title">{title}</h1>
        <p className="note">{words.length} word{words.length === 1 ? "" : "s"} · Read at your own pace. Press 🔊 to hear a word.</p>
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
            <p className="study__ja" lang="ja">
              <span className="study__label">日本語</span> {w.ja.length ? w.ja.join(" / ") : <em>—</em>}
            </p>
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

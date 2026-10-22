"use client";

import { useState } from "react";
import { Bulbs } from "./Stage";
import type { VocabSet } from "@/data/vocab";
import { MAX_NAME_LENGTH } from "@/lib/game";
import { play } from "@/lib/sound";
import { clampPlayCount, DEFAULT_PLAY_COUNT } from "@/lib/playCount";
import { PlayCount } from "./PlayCount";
import { HostClass } from "./class/HostClass";

export function Welcome({
  onStart,
  sets,
  selectedId,
  onSelectSet,
  onOpenStudio,
}: {
  onStart: (names: [string, string], count: number) => void;
  sets: VocabSet[];
  selectedId: string;
  onSelectSet: (id: string) => void;
  onOpenStudio: () => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [count, setCount] = useState(DEFAULT_PLAY_COUNT);
  const available = sets.find((s) => s.id === selectedId)?.words.length ?? sets[0]?.words.length ?? 1;
  const playCount = clampPlayCount(count, available);

  return (
    <main className="screen welcome">
      <div className="welcome__title">
        <p className="eyebrow">Tonight on stage</p>
        <Bulbs />
        <h1 className="title">
          <span className="title__small">Vocabulary</span>
          <span className="title__big">Quiz</span>
          <span className="title__big title__big--alt">Show</span>
        </h1>
        <Bulbs />
        <p className="tagline">Explain it. Guess it. <em>Say it out loud.</em></p>
      </div>

      <div className="welcome__form">
        {sets.length > 1 ? (
          <label className="field">
            <span className="field__label">Word set</span>
            <select className="setselect" value={selectedId} onChange={(e) => onSelectSet(e.target.value)}>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </label>
        ) : null}

        <section className="mode mode--class" aria-labelledby="mode-class">
          <h2 id="mode-class" className="mode__title"><span className="mode__badge">Classroom mode</span> Two phones</h2>
          <p className="note">
            Each student plays on their own phone with a private screen: one is the Giver, the other is the Taker.
            Students scan the teacher&apos;s QR code, then enter a name and a group number.
          </p>
          <HostClass />
          <button type="button" className="btn btn--studio" onClick={onOpenStudio}>
            Teacher Studio
          </button>
        </section>

        <form
          className="mode mode--demo"
          aria-labelledby="mode-demo"
          onSubmit={(e) => {
            e.preventDefault();
            play("tap");
            onStart([a, b], playCount);
          }}
        >
          <h2 id="mode-demo" className="mode__title"><span className="mode__badge mode__badge--demo">Demo mode</span> One screen</h2>
          <p className="note">Try the game on this one screen — both roles share it. Not for class use: the Taker could see the Giver&apos;s screen.</p>
          <label className="field">
            <span className="field__label">Contestant 1</span>
            <input
              value={a}
              onChange={(e) => setA(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="Player 1"
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="next"
            />
          </label>
          <label className="field">
            <span className="field__label">Contestant 2</span>
            <input
              value={b}
              onChange={(e) => setB(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="Player 2"
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="go"
            />
          </label>
          <PlayCount available={available} value={playCount} onChange={setCount} />
          <button type="submit" className="btn btn--hero">Start demo game</button>
        </form>
      </div>

      <ol className="howto">
        <li><span><b>Giver</b> sees the word and an opening hint (free, Giver only) and explains it — out loud, in their own words, never reading it.</span></li>
        <li><span><b>Taker</b> asks as many questions as they like, then types or says a guess. Know it but not in English? Answer in Japanese for half the points.</span></li>
        <li><span>Extra hints cost points. Swap roles after every word.</span></li>
      </ol>
    </main>
  );
}

"use client";

import { useState } from "react";
import { Bulbs } from "./Stage";
import type { VocabSet } from "@/data/vocab";
import { MAX_NAME_LENGTH } from "@/lib/game";
import { play } from "@/lib/sound";
import { HostClass } from "./class/HostClass";

export function Welcome({
  onStart,
  sets,
  selectedId,
  onSelectSet,
  onOpenStudio,
}: {
  onStart: (names: [string, string]) => void;
  sets: VocabSet[];
  selectedId: string;
  onSelectSet: (id: string) => void;
  onOpenStudio: () => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");

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

      <form
        className="welcome__form"
        onSubmit={(e) => {
          e.preventDefault();
          play("tap");
          onStart([a, b]);
        }}
      >
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
        <button type="submit" className="btn btn--hero">Start Game</button>
        <button type="button" className="btn btn--studio" onClick={onOpenStudio}>
          Teacher Studio
        </button>
        <HostClass set={sets.find((x) => x.id === selectedId) ?? sets[0]} />
        <button type="button" className="btn btn--ghost" disabled aria-describedby="pair-note">
          Pair two phones
        </button>
        <p id="pair-note" className="note">
          Coming soon — this prototype runs both roles on <strong>one screen</strong> (demo mode).
        </p>
      </form>

      <ol className="howto">
        <li><span><b>Giver</b> sees the word and explains it — out loud, never reading it.</span></li>
        <li><span><b>Taker</b> asks questions, then types or dictates a guess.</span></li>
        <li><span>Fewer hints, more points. Swap roles after every word.</span></li>
      </ol>
    </main>
  );
}

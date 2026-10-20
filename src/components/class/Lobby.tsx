"use client";

import { useState } from "react";
import { MAX_NAME_LENGTH } from "@/lib/game";
import { play } from "@/lib/sound";
import type { ClassView, ClientAction } from "@/lib/class/types";
import { Bulbs } from "../Stage";

export function Presence({ name, connected, you }: { name: string; connected: boolean; you?: boolean }) {
  return (
    <li className={`presence ${connected ? "is-on" : "is-off"}`}>
      <span className="presence__dot" aria-hidden="true" />
      <span className="presence__name">{name}{you ? " (you)" : ""}</span>
      <span className="presence__state">{connected ? "connected" : "reconnecting…"}</span>
    </li>
  );
}

export function JoinForm({
  title,
  error,
  busy,
  onJoin,
}: {
  title: string;
  error: string | null;
  busy: boolean;
  onJoin: (name: string, group: string) => void;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  return (
    <main className="screen welcome">
      <div className="welcome__title">
        <p className="eyebrow">Classroom game</p>
        <Bulbs />
        <h1 className="title">
          <span className="title__small">Vocabulary</span>
          <span className="title__big">Quiz</span>
          <span className="title__big title__big--alt">Show</span>
        </h1>
        <p className="tagline">{title}</p>
      </div>
      <form
        className="welcome__form"
        onSubmit={(e) => {
          e.preventDefault();
          play("tap");
          onJoin(name, group);
        }}
      >
        <label className="field">
          <span className="field__label">Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME_LENGTH} autoComplete="off" autoCapitalize="words" enterKeyHint="next" required />
        </label>
        <label className="field">
          <span className="field__label">Group number</span>
          <input
            value={group}
            onChange={(e) => setGroup(e.target.value.replace(/\D/g, "").slice(0, 3))}
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="e.g. 7"
            autoComplete="off"
            enterKeyHint="go"
            required
          />
        </label>
        {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
        <button type="submit" className="btn btn--hero" disabled={busy || !name.trim() || !group}>
          {busy ? "Joining…" : "Join group"}
        </button>
        <p className="note">Your partner enters the same group number on their own phone. Only two players can share a group.</p>
      </form>
    </main>
  );
}

export function Waiting({ view, onLeave }: { view: ClassView; onLeave: () => void }) {
  return (
    <main className="screen lobby" aria-live="polite">
      <p className="eyebrow">Group</p>
      <h2 className="lobby__group">{view.group}</h2>
      <Bulbs />
      <h3 className="screen__title">Waiting for your partner…</h3>
      <ul className="presence-list">
        <Presence name={view.you.name} connected you />
        <li className="presence is-off is-empty">
          <span className="presence__dot" aria-hidden="true" />
          <span className="presence__name">Partner</span>
          <span className="presence__state">not here yet</span>
        </li>
      </ul>
      <p className="note">Ask your partner to open the same link and enter group <b>{view.group}</b>.</p>
      <button type="button" className="btn btn--link" onClick={onLeave}>Wrong group? Leave</button>
    </main>
  );
}

export function Roles({ view, act }: { view: ClassView; act: (a: ClientAction) => void }) {
  const partner = view.partner!;
  const p = view.proposal;
  return (
    <main className="screen lobby" aria-live="polite">
      <p className="eyebrow">Group {view.group}</p>
      <h2 className="screen__title">Choose your roles</h2>
      <ul className="presence-list">
        <Presence name={view.you.name} connected you />
        <Presence name={partner.name} connected={partner.connected} />
      </ul>

      {!p ? (
        <>
          <p className="tagline">Who explains the first word?</p>
          <div className="lobby__choices">
            <button type="button" className="btn btn--hero" onClick={() => act({ type: "PROPOSE_ROLES", giver: "me" })}>I&apos;ll be the Giver</button>
            <button type="button" className="btn btn--ghost" onClick={() => act({ type: "PROPOSE_ROLES", giver: "partner" })}>
              I&apos;ll be the Taker
            </button>
          </div>
          <p className="note">The Giver sees the word and explains it aloud. The Taker asks questions and guesses. You swap after every word.</p>
        </>
      ) : p.youProposed ? (
        <>
          <p className="tagline">
            You suggested <b className="c-gold">{p.giverName}</b> as Giver and <b className="c-cyan">{p.takerName}</b> as Taker.
          </p>
          <p className="note" role="status">Waiting for {partner.name} to confirm…</p>
          <button type="button" className="btn btn--link" onClick={() => act({ type: "PROPOSE_ROLES", giver: p.youAreGiver ? "partner" : "me" })}>
            Swap roles instead
          </button>
        </>
      ) : (
        <>
          <p className="tagline">
            {partner.name} suggests: <b className="c-gold">{p.giverName}</b> is the Giver, <b className="c-cyan">{p.takerName}</b> is the Taker.
          </p>
          <div className="lobby__choices">
            <button type="button" className="btn btn--hero" disabled={!partner.connected} onClick={() => act({ type: "CONFIRM_ROLES" })}>
              Sounds good — start!
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => act({ type: "PROPOSE_ROLES", giver: p.youAreGiver ? "partner" : "me" })}>
              Swap roles
            </button>
          </div>
        </>
      )}
    </main>
  );
}

"use client";

import { useState } from "react";
import { addCandidate, countCandidates, groupedCandidates, removeCandidate, replaceCandidate } from "@/lib/studio/candidates";
import type { Brief } from "@/lib/studio/types";

const LABELS = { familiar: "Familiar", moderate: "Moderately challenging", unfamiliar: "Unfamiliar", other: "Your words" } as const;

/**
 * The candidate words before approval, editable one at a time: edit, replace, delete, add. Nothing here calls the AI,
 * and nothing else in the list changes. Hand edits survive the rest of the conversation (see mergeAiCandidates).
 */
export function CandidateEditor({ brief, busy, onChange }: { brief: Brief; busy: boolean; onChange: (b: Brief) => void }) {
  const [editing, setEditing] = useState<{ word: string; mode: "edit" | "replace"; text: string } | null>(null);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const count = countCandidates(brief);

  const apply = (r: ReturnType<typeof addCandidate>): boolean => {
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setError(null);
    onChange(r.brief);
    return true;
  };

  return (
    <div className="brief brief--candidates cands" aria-label="Candidate words">
      <p className="cands__head">
        <span className="brief__label">Candidate words</span> <b aria-live="polite">{count} word{count === 1 ? "" : "s"}</b>
        <span className="note"> — edit, replace, delete or add any word. Nothing is regenerated.</span>
      </p>
      {groupedCandidates(brief).map((g) => (
        <div key={g.key} className="cands__group">
          <span className="brief__label">{LABELS[g.key]}</span>
          <ul className="cands__list">
            {g.words.map((w) => (
              <li key={w} className="cands__item">
                {editing?.word === w ? (
                  <form
                    className="cands__edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (apply(replaceCandidate(brief, w, editing.text))) setEditing(null);
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={editing.mode === "edit" ? `Edit ${w}` : `Replace ${w} with`}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      placeholder={editing.mode === "replace" ? `Replace “${w}” with…` : undefined}
                      maxLength={60}
                    />
                    <button type="submit" className="btn btn--small" disabled={busy || !editing.text.trim()}>Save</button>
                    <button type="button" className="btn btn--small btn--ghost" onClick={() => { setEditing(null); setError(null); }}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <span className="cands__word">{w}</span>
                    <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => setEditing({ word: w, mode: "edit", text: w })} aria-label={`Edit ${w}`}>Edit</button>
                    <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => setEditing({ word: w, mode: "replace", text: "" })} aria-label={`Replace ${w}`}>Replace</button>
                    <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => apply(removeCandidate(brief, w))} aria-label={`Delete ${w}`}>Delete</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form
        className="cands__add"
        onSubmit={(e) => {
          e.preventDefault();
          if (apply(addCandidate(brief, adding))) setAdding("");
        }}
      >
        <label className="sr-only" htmlFor="cand-add">Add a word</label>
        <input id="cand-add" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a word of your own" maxLength={60} disabled={busy} />
        <button type="submit" className="btn btn--small" disabled={busy || !adding.trim()}>Add word</button>
      </form>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
    </div>
  );
}

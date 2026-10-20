"use client";

import { useState } from "react";
import { CEFR_LEVELS, PARTS_OF_SPEECH, type VocabWord } from "@/data/vocab";
import { validateWord, type WordIssue } from "@/lib/studio/validation";

export interface WordRowProps {
  index: number;
  word: VocabWord;
  locked: boolean;
  open: boolean;
  disabled: boolean;
  busyWordId: string | null;
  onToggleOpen: () => void;
  onEdit: (patch: Partial<Omit<VocabWord, "id">>) => void;
  onToggleLock: () => void;
  onReplace: (instruction: string) => void;
  onNewHints: (instruction: string) => void;
}

const fieldIssues = (issues: WordIssue[], field: WordIssue["field"], hint?: number) =>
  issues.filter((i) => i.field === field && (hint === undefined || i.hintIndex === hint));

function Problems({ issues }: { issues: WordIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="problems">
      {issues.map((i, k) => (
        <li key={k} className={i.severity === "error" ? "is-error" : "is-warn"}>
          {i.severity === "error" ? "⚠ " : "• "}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function WordRow(p: WordRowProps) {
  const { word: w } = p;
  const issues = validateWord(w);
  const errors = issues.filter((i) => i.severity === "error").length;
  const working = p.busyWordId === w.id;
  const [instr, setInstr] = useState("");
  const [acceptText, setAcceptText] = useState((w.accept ?? []).join(", "));
  const panelId = `word-${w.id}`;

  const commitAccept = () => {
    const list = acceptText.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
    p.onEdit({ accept: list.slice(0, 8) });
  };

  return (
    <li className={`item ${p.open ? "is-open" : ""} ${working ? "is-working" : ""}`}>
      <button type="button" className="item__head" aria-expanded={p.open} aria-controls={panelId} onClick={p.onToggleOpen}>
        <span className="item__n">{p.index + 1}</span>
        <span className="item__body">
          <span className="item__word">{w.word || <em>(empty)</em>}</span>
          <span className="item__meta">
            {w.cefr} · {w.partOfSpeech} · {w.category}
          </span>
          {!p.open ? <span className="item__def">{w.meaning}</span> : null}
        </span>
        <span className="item__flags">
          {p.locked ? <span title="Locked: kept when the set is regenerated" aria-label="Locked">🔒</span> : null}
          {errors > 0 ? <span className="flag-err" aria-label={`${errors} problem${errors === 1 ? "" : "s"}`}>⚠ {errors}</span> : null}
          <span className="item__chev" aria-hidden="true">{p.open ? "▾" : "▸"}</span>
        </span>
      </button>

      {p.open ? (
        <div className="editor" id={panelId}>
          <div className="editor__grid">
            <label className="fld fld--wide">
              <span>Target word or expression</span>
              <input value={w.word} onChange={(e) => p.onEdit({ word: e.target.value })} maxLength={60} disabled={p.disabled} />
              <Problems issues={fieldIssues(issues, "word")} />
            </label>
            <label className="fld">
              <span>CEFR</span>
              <select value={w.cefr} onChange={(e) => p.onEdit({ cefr: e.target.value as VocabWord["cefr"] })} disabled={p.disabled}>
                {CEFR_LEVELS.map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
            <label className="fld">
              <span>Part of speech</span>
              <select value={w.partOfSpeech} onChange={(e) => p.onEdit({ partOfSpeech: e.target.value as VocabWord["partOfSpeech"] })} disabled={p.disabled}>
                {PARTS_OF_SPEECH.map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
            <label className="fld fld--wide">
              <span>Category <small>(the Taker can see this)</small></span>
              <input value={w.category} onChange={(e) => p.onEdit({ category: e.target.value })} maxLength={60} disabled={p.disabled} />
              <Problems issues={fieldIssues(issues, "category")} />
            </label>
          </div>

          <label className="fld">
            <span>Definition <small>(Giver only)</small></span>
            <textarea rows={2} value={w.meaning} onChange={(e) => p.onEdit({ meaning: e.target.value })} maxLength={300} disabled={p.disabled} />
            <Problems issues={fieldIssues(issues, "meaning")} />
          </label>
          <label className="fld">
            <span>Example sentence</span>
            <textarea rows={2} value={w.example} onChange={(e) => p.onEdit({ example: e.target.value })} maxLength={300} disabled={p.disabled} />
            <Problems issues={fieldIssues(issues, "example")} />
          </label>

          <fieldset className="hintset">
            <legend>Spoken hints — from vague to strong</legend>
            {[0, 1, 2].map((i) => (
              <label className="fld fld--hint" key={i}>
                <span className="hintset__n">{i + 1}</span>
                <input
                  aria-label={`Hint ${i + 1}`}
                  value={w.hints[i] ?? ""}
                  onChange={(e) => {
                    const hints = [...w.hints];
                    while (hints.length < 3) hints.push("");
                    hints[i] = e.target.value;
                    p.onEdit({ hints });
                  }}
                  maxLength={200}
                  disabled={p.disabled}
                />
                <Problems issues={fieldIssues(issues, "hints", i)} />
              </label>
            ))}
          </fieldset>

          <label className="fld">
            <span>Also accept <small>(comma-separated alternatives, e.g. plurals or spelling variants)</small></span>
            <input
              key={`${w.id}:${(w.accept ?? []).join("|")}`}
              value={acceptText}
              onChange={(e) => setAcceptText(e.target.value)}
              onBlur={commitAccept}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitAccept(); } }}
              placeholder="none"
              disabled={p.disabled}
            />
          </label>

          <div className="editor__ai">
            <label className="fld">
              <span>Instruction for AI <small>(optional)</small></span>
              <input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="e.g. “something less common” or “easier hints”" maxLength={300} disabled={p.disabled} />
            </label>
            <div className="row row--left">
              <button type="button" className="btn btn--small" disabled={p.disabled} onClick={() => p.onReplace(instr)}>
                {working ? "Working…" : "Replace this word (AI)"}
              </button>
              <button type="button" className="btn btn--small btn--ghost" disabled={p.disabled} onClick={() => p.onNewHints(instr)}>
                New hints (AI)
              </button>
              <button type="button" className="btn btn--small btn--ghost" aria-pressed={p.locked} onClick={p.onToggleLock}>
                {p.locked ? "🔒 Locked" : "Lock word"}
              </button>
            </div>
            <p className="note">Only this word changes. Locked words are kept when you regenerate the whole set.</p>
          </div>
        </div>
      ) : null}
    </li>
  );
}

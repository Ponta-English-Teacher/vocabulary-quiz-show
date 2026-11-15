"use client";

import { useMemo, useState } from "react";
import { CEFR_LEVELS, PARTS_OF_SPEECH } from "@/data/vocab";
import { BANK_LIMITS } from "@/lib/bank/validate";
import { HINT_ROLES, OPENING_EXAMPLES, issuesForForm, spokenWordCount, type WordForm } from "@/lib/bank/view";
import { IssueLists } from "./Issues";

/** Edit or create one word: every field, four hints in order, and live problems (separate from review notes). Saving never approves. */
export function WordEditor({ title, initial, submitLabel, busy, serverError, note, onSubmit, onCancel }: {
  title: string;
  initial: WordForm;
  submitLabel: string;
  busy: boolean;
  serverError: string | null;
  note?: string;
  onSubmit: (f: WordForm) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<WordForm>(initial);
  const { errors, warnings } = useMemo(() => issuesForForm(f), [f]);
  const set = <K extends keyof WordForm>(k: K, v: WordForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const setHint = (i: number, v: string) => setF((p) => ({ ...p, hints: p.hints.map((h, k) => (k === i ? v : h)) }));
  const canSave = !busy && !!f.word.trim() && !!f.category.trim();

  return (
    <form className="wb__editor" onSubmit={(e) => { e.preventDefault(); if (canSave) onSubmit(f); }}>
      <h3 className="wb__editor-title">{title}</h3>
      {note ? <p className="note">{note}</p> : null}
      <div className="wb__grid">
        <label className="field"><span className="field__label">Target word</span>
          <input value={f.word} maxLength={BANK_LIMITS.word} onChange={(e) => set("word", e.target.value)} autoCapitalize="none" /></label>
        <label className="field"><span className="field__label">Also accepted (separate with ;)</span>
          <input value={f.accept} onChange={(e) => set("accept", e.target.value)} placeholder="colour; color" /></label>
        <label className="field"><span className="field__label">Part of speech</span>
          <select className="setselect" value={f.partOfSpeech} onChange={(e) => set("partOfSpeech", e.target.value)}>{PARTS_OF_SPEECH.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="field"><span className="field__label">CEFR level</span>
          <select className="setselect" value={f.cefr} onChange={(e) => set("cefr", e.target.value)}>{CEFR_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        <label className="field"><span className="field__label">Category</span>
          <input value={f.category} maxLength={BANK_LIMITS.category} onChange={(e) => set("category", e.target.value)} placeholder="Kitchen tools" /></label>
        <label className="field"><span className="field__label">Topic (optional)</span>
          <input value={f.topic} maxLength={BANK_LIMITS.topic} onChange={(e) => set("topic", e.target.value)} /></label>
      </div>
      <label className="field"><span className="field__label">Japanese meaning (optional · shown to the Giver only)</span>
        <input value={f.giverJa} maxLength={BANK_LIMITS.giverJa} onChange={(e) => set("giverJa", e.target.value)} lang="ja" placeholder="水切りざる" />
        <span className="note">Helps the Giver confirm the meaning. It is never shown to the Taker and never used for scoring.</span></label>

      <label className="field wb__opening"><span className="field__label">Spoken Opening Question (optional · Giver says it first · never shown to the Taker)</span>
        <input value={f.openingQuestion} maxLength={BANK_LIMITS.openingQuestion + 20} onChange={(e) => set("openingQuestion", e.target.value)} placeholder="This is an action. What is it?" />
        <span className="note">Say what KIND of thing it is (a fruit, a tool, an action, a feeling, a concept), not its grammar (noun, verb, adjective). It is free: it is not one of the four hints and does not change the score.</span>
        <span className="wb__chips" role="group" aria-label="Opening question examples">
          {OPENING_EXAMPLES.map((x) => <button key={x} type="button" className="btn btn--small btn--ghost" onClick={() => set("openingQuestion", x)}>{x}</button>)}
        </span></label>

      <fieldset className="wb__hintset">
        <legend className="field__label">Four hints — from least to most helpful</legend>
        {HINT_ROLES.map((r, i) => (
          <label key={r.n} className="field wb__hintfield">
            <span className="wb__hint-title">{r.title}</span>
            <span className="note">{r.detail}</span>
            <textarea rows={2} value={f.hints[i]} maxLength={BANK_LIMITS.hintMax + 40} onChange={(e) => setHint(i, e.target.value)} />
            <span className="note wb__count">{spokenWordCount(f.hints[i])} words · say it aloud in one breath</span>
          </label>
        ))}
      </fieldset>

      <details className="fold">
        <summary>Meaning and example for the Giver (optional)</summary>
        <label className="field"><span className="field__label">Meaning</span><textarea rows={2} value={f.meaning} maxLength={BANK_LIMITS.meaning} onChange={(e) => set("meaning", e.target.value)} /></label>
        <label className="field"><span className="field__label">Example sentence</span><textarea rows={2} value={f.example} maxLength={BANK_LIMITS.example} onChange={(e) => set("example", e.target.value)} /></label>
      </details>

      <IssueLists errors={errors} warnings={warnings} />
      {serverError ? <p className="feedback feedback--wrong" role="alert">{serverError}</p> : null}
      <div className="wb__actions">
        <button type="submit" className="btn btn--hero" disabled={!canSave}>{busy ? "Saving…" : submitLabel}</button>
        {onCancel ? <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button> : null}
      </div>
      <p className="note">Saving keeps the word as a draft. Approve it afterwards from the list; nothing is approved automatically.</p>
    </form>
  );
}

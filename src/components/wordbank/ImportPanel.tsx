"use client";

import { useRef, useState } from "react";
import type { ImportAnalysis, RecordStatus } from "@/lib/bank/import";
import type { ImportOutcome, WordbankApi } from "@/lib/bank/client";
import { IssueLists } from "./Issues";

const STATUS_TEXT: Record<RecordStatus, string> = {
  valid: "Ready",
  warning: "Ready, with notes",
  review: "Needs your decision",
  duplicate: "Duplicate — will not be imported",
  invalid: "Has errors — will not be imported",
};

/** Step 1: choose a file (or paste text), preview every record with its problems and duplicates, then import the ones you accept as DRAFTS. */
export function ImportPanel({ api, onImported }: { api: WordbankApi; onImported: () => void }) {
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | undefined>();
  const [analysis, setAnalysis] = useState<(ImportAnalysis & { format?: string }) | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setAnalysis(null); setKeep(new Set()); setOutcome(null); setError(null); };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    reset();
    try {
      setText(await file.text());
      setFilename(file.name);
    } catch {
      setError("The file could not be read.");
    }
  };

  const preview = async () => {
    setBusy(true);
    reset();
    const r = await api.preview(text, filename);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    if (r.data.fileErrors?.length) return setError(r.data.fileErrors[0]);
    setAnalysis(r.data);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await api.importDrafts(text, filename, [...keep]);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setOutcome(r.data);
    setAnalysis(null);
    onImported();
  };

  const toImport = analysis ? analysis.records.filter((r) => r.importable || (r.status === "review" && keep.has(r.index))).length : 0;

  return (
    <section className="wb__panel">
      <h2 className="wb__h2">Import words</h2>
      <p className="note">Upload a JSON or CSV file written with the template and prompt (Tools tab). You will see every word checked <b>before</b> anything is saved, and imported words always start as <b>drafts</b> that you must approve yourself.</p>
      <div className="wb__actions">
        <label className="btn btn--small btn--ghost wb__file">
          Choose a JSON or CSV file…
          <input ref={fileRef} type="file" accept=".json,.csv,.tsv,.txt,application/json,text/csv" hidden onChange={(e) => void choose(e.target.files?.[0])} />
        </label>
        {filename ? <span className="note">{filename}</span> : null}
      </div>
      <label className="field"><span className="field__label">…or paste the file's text</span>
        <textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setFilename(undefined); reset(); }} placeholder='[{"word": "colander", …}]' /></label>
      <button type="button" className="btn btn--hero" disabled={busy || !text.trim()} onClick={preview}>{busy && !analysis ? "Checking…" : "Preview and check"}</button>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}

      {analysis ? (
        <div className="wb__preview" role="region" aria-label="Import preview">
          <p className="wb__counts" role="status">
            <b>{analysis.counts.total}</b> words · <span className="c-good">{analysis.counts.valid + analysis.counts.warning} ready</span> · <span className="c-gold">{analysis.counts.review} need a decision</span> · {analysis.counts.duplicate} duplicate · <span className="c-bad">{analysis.counts.invalid} with errors</span>
          </p>
          <ul className="wb__records">
            {analysis.records.slice(0, 200).map((r) => (
              <li key={r.index} className={`wb__record wb__record--${r.status}`}>
                <div className="wb__record-head">
                  <span className="wb__word">{r.candidate?.word || `Row ${r.index}`}</span>
                  <span className="note">row {r.index} · {r.candidate ? `${r.candidate.cefr} · ${r.candidate.category}` : ""}</span>
                  <span className={`wb__badge wb__badge--${r.status}`}>{STATUS_TEXT[r.status]}</span>
                </div>
                {r.note ? <p className="note">{r.note}</p> : null}
                {r.status === "review" ? (
                  <label className="wb__keep"><input type="checkbox" checked={keep.has(r.index)} onChange={(e) => setKeep((p) => { const n = new Set(p); if (e.target.checked) n.add(r.index); else n.delete(r.index); return n; })} /> Keep this one too (as a draft)</label>
                ) : null}
                <IssueLists errors={r.errors} warnings={r.warnings} />
              </li>
            ))}
          </ul>
          {analysis.records.length > 200 ? <p className="note">Showing the first 200 of {analysis.records.length} records. The counts above cover all of them.</p> : null}
          <button type="button" className="btn btn--hero" disabled={busy || toImport < 1} onClick={run}>{busy ? "Importing…" : `Import ${toImport} word${toImport === 1 ? "" : "s"} as drafts`}</button>
          <p className="note">Importing is safe to repeat: the same file is never added twice.</p>
        </div>
      ) : null}

      {outcome ? (
        <div className="wb__done" role="status">
          <p><b>{outcome.replayed ? "This file was already imported — nothing new was added." : `Imported ${outcome.created} draft${outcome.created === 1 ? "" : "s"}.`}</b></p>
          <p className="note">Skipped: {outcome.skipped.duplicate} duplicate, {outcome.skipped.invalid} with errors, {outcome.skipped.heldForReview} held for review{outcome.skipped.alreadyAdded ? `, ${outcome.skipped.alreadyAdded} already added` : ""}.</p>
          <p className="note">Next: open the <b>Review</b> tab to check, edit and approve your drafts.</p>
        </div>
      ) : null}
    </section>
  );
}

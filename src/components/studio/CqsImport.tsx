"use client";

import { useMemo, useState } from "react";
import { CEFR_LEVELS } from "@/data/vocab";
import { convertExport, groupIntoSets, importedSourceIds, parseCqsExport, type ImportItem, type ImportReport } from "@/lib/studio/cqsImport";
import { approveSet, createActivity, createSet } from "@/lib/studio/ops";
import { getBrowserStorage, loadActivities, saveActivity } from "@/lib/studio/storage";

const SHOW_LIMIT = 100;

/**
 * Import approved questions from a Classroom Quiz Show JSON export: choose a file on this computer, preview what would be imported,
 * skipped and flagged (with reasons), tick the words you want, and save them as NEW approved sets. The file is only read, never changed;
 * existing activities are never touched; nothing is sent anywhere and no AI is used.
 */
export function CqsImport({ onBack, onSaved }: { onBack: () => void; onSaved: (text: string) => void }) {
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cefr, setCefr] = useState("all");
  const [category, setCategory] = useState("all");
  const [showFlagged, setShowFlagged] = useState(true);
  const [limit, setLimit] = useState(SHOW_LIMIT);
  const [title, setTitle] = useState(() => `Classroom Quiz Show import ${new Date().toISOString().slice(0, 10)}`);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async (file: File | undefined) => {
    setError(null);
    setReport(null);
    setPicked(new Set());
    setSaveError(null);
    if (!file) return;
    setFileName(file.name);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("The file could not be read.");
      return;
    }
    const parsed = parseCqsExport(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const already = importedSourceIds(loadActivities(getBrowserStorage()).activities);
    setReport(convertExport(parsed.questions, already));
    setLimit(SHOW_LIMIT);
  };

  const categories = useMemo(() => [...new Set((report?.items ?? []).filter((i) => i.status !== "skipped").map((i) => i.category))].sort(), [report]);
  const importable = (report?.items ?? []).filter((i) => i.status !== "skipped" && i.word);
  const shown = importable.filter((i) => (cefr === "all" || i.cefr === cefr) && (category === "all" || i.category === category) && (showFlagged || i.status === "ready"));
  const skipped = (report?.items ?? []).filter((i) => i.status === "skipped");
  const chosen = importable.filter((i) => picked.has(i.sourceId));

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectShownReady = () => setPicked((p) => { const n = new Set(p); shown.filter((i) => i.status === "ready").forEach((i) => n.add(i.sourceId)); return n; });

  const save = () => {
    setSaveError(null);
    const words = chosen.map((i) => i.word!);
    if (!words.length) return;
    let a = createActivity(title.trim().slice(0, 80) || "Classroom Quiz Show import");
    a = { ...a, brief: { ...a.brief, topic: "Imported from Classroom Quiz Show" }, sets: groupIntoSets(words).map((s) => createSet(s.words, s.title)) };
    let notApproved = 0;
    for (const s of a.sets) {
      const r = approveSet(a, s.id);
      if (r.problems.length) notApproved++;
      a = r.activity;
    }
    const res = saveActivity(getBrowserStorage(), a); // a NEW activity: nothing existing is replaced
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    onSaved(`Imported ${words.length} word${words.length === 1 ? "" : "s"} into ${a.sets.length} new set${a.sets.length === 1 ? "" : "s"} in “${a.title}”${notApproved ? ` (${notApproved} set${notApproved === 1 ? "" : "s"} need${notApproved === 1 ? "s" : ""} a look before they can be approved)` : ", all approved and ready to host"}. Your other activities were not changed.`);
  };

  return (
    <section className="studio-home cqs" aria-labelledby="cqs-title">
      <div className="studio-head">
        <h2 id="cqs-title" className="studio-h">Import from Classroom Quiz Show</h2>
        <button type="button" className="btn btn--link" onClick={onBack}>‹ Back to the library</button>
      </div>
      <p className="note">
        Choose a Classroom Quiz Show export (<code>classroom-quiz-show/questions</code>, version 1). Only approved questions are imported. The answer becomes the word to explain,
        and the four clues become the hints. Classroom Quiz Show has no definitions, examples or Japanese, so imported words have none (nothing is made up, and no AI is used).
        The file is only read, never changed.
      </p>
      <label className="field">
        <span className="field__label">Export file (.json)</span>
        <input type="file" accept=".json,application/json" onChange={(e) => void load(e.target.files?.[0])} />
      </label>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}

      {report ? (
        <>
          <p className="cqs__summary" role="status">
            <b>{fileName}</b>: {report.counts.total} questions · <span className="c-good">{report.counts.ready} ready</span> · <span className="c-gold">{report.counts.flagged} flagged</span> · {report.counts.skipped} skipped
            {report.counts.notApproved ? ` (${report.counts.notApproved} not approved)` : ""}
          </p>
          <p className="note">
            <b>Ready</b> words look suitable. <b>Flagged</b> words are probably awkward for a spoken explain-and-guess game (for example names, titles, or picture clues): read the reason and include one only if you want it.
            <b> Skipped</b> questions cannot be imported.
          </p>

          <div className="cqs__filters">
            <label className="field"><span className="field__label">Level</span>
              <select className="setselect" value={cefr} onChange={(e) => { setCefr(e.target.value); setLimit(SHOW_LIMIT); }}>
                <option value="all">All levels</option>
                {CEFR_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label className="field"><span className="field__label">Category</span>
              <select className="setselect" value={category} onChange={(e) => { setCategory(e.target.value); setLimit(SHOW_LIMIT); }}>
                <option value="all">All categories</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="cqs__check"><input type="checkbox" checked={showFlagged} onChange={(e) => setShowFlagged(e.target.checked)} /> Show flagged</label>
          </div>
          <div className="cqs__bar">
            <button type="button" className="btn btn--small" onClick={selectShownReady}>Select all ready words shown</button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear selection</button>
            <span className="note">{chosen.length} selected · {shown.length} shown</span>
          </div>

          <ul className="cqs__list">
            {shown.slice(0, limit).map((i) => <Row key={i.sourceId} item={i} checked={picked.has(i.sourceId)} onToggle={() => toggle(i.sourceId)} />)}
          </ul>
          {shown.length > limit ? <button type="button" className="btn btn--small btn--ghost" onClick={() => setLimit((n) => n + SHOW_LIMIT)}>Show more ({shown.length - limit} more)</button> : null}
          {shown.length === 0 ? <p className="empty">Nothing matches these filters.</p> : null}

          {skipped.length ? (
            <details className="fold">
              <summary>Skipped ({skipped.length}) — not imported</summary>
              <ul className="cqs__skipped">
                {skipped.map((i) => <li key={`${i.sourceId}-${i.label}`}><b>{i.label}</b> <span className="note">({i.cefr} · {i.category})</span><br /><span className="note">{i.reasons.join(" ")}</span></li>)}
              </ul>
            </details>
          ) : null}

          <div className="cqs__save">
            <label className="field"><span className="field__label">Save as a new activity called</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
            </label>
            <button type="button" className="btn btn--hero" disabled={!chosen.length} onClick={save}>
              Save {chosen.length} word{chosen.length === 1 ? "" : "s"} as approved sets
            </button>
            <p className="note">Words are grouped by level and category, up to ten per set. This creates a new activity; your existing activities and sets are not changed. You can edit or delete the new sets in the library.</p>
            {saveError ? <p className="feedback feedback--wrong" role="alert">{saveError}</p> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function Row({ item, checked, onToggle }: { item: ImportItem; checked: boolean; onToggle: () => void }) {
  const w = item.word!;
  return (
    <li className={`cqs__row cqs__row--${item.status}`}>
      <label className="cqs__pick">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Include ${w.word}`} />
        <span className="cqs__word">{w.word}</span>
        <span className="cqs__tag">{item.status === "ready" ? "Ready" : "Flagged"}</span>
        <span className="note">{item.cefr} · {item.category}</span>
      </label>
      {item.reasons.length ? <p className="cqs__why">⚠ {item.reasons.join(" ")}</p> : null}
      <details className="cqs__hints">
        <summary>Hints{item.notes.length ? " and notes" : ""}</summary>
        <ol>{w.hints.map((h, n) => <li key={n}>{h}{n === 0 ? " (free opening hint)" : ""}</li>)}</ol>
        {w.accept?.length ? <p className="note">Also accepted: {w.accept.join(", ")}</p> : null}
        {item.notes.length ? <p className="note">{item.notes.join(" ")}</p> : null}
      </details>
    </li>
  );
}

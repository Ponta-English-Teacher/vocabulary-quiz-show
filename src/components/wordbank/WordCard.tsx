import type { BankWord } from "@/lib/bank/types";
import { STATUS_LABEL, issuesOf } from "@/lib/bank/view";
import { HintList } from "./HintList";
import { IssueLists } from "./Issues";

export interface WordCardProps {
  word: BankWord;
  selected: boolean;
  busy: boolean;
  onSelect: (id: string, on: boolean) => void;
  onEdit: (w: BankWord) => void;
  onApprove: (w: BankWord) => void;
  onArchive: (w: BankWord) => void;
  onRestore: (w: BankWord) => void;
}

/** One word: target, level, status, the four hints in order, the Giver-only Japanese meaning, problems and actions. */
export function WordCard({ word: w, selected, busy, onSelect, onEdit, onApprove, onArchive, onRestore }: WordCardProps) {
  const { errors, warnings } = issuesOf(w);
  const source = w.source === "classroom-quiz-show" ? "From Classroom Quiz Show" : w.source === "manual" ? "Written by hand" : "From a file";
  return (
    <li className={`wb__card wb__card--${w.status}`}>
      <div className="wb__card-head">
        {w.status === "draft" ? (
          <label className="wb__pick">
            <input type="checkbox" checked={selected} onChange={(e) => onSelect(w.id, e.target.checked)} aria-label={`Select ${w.word}`} />
          </label>
        ) : null}
        <div className="wb__title">
          <span className="wb__word">{w.word}</span>
          <span className={`wb__badge wb__badge--${w.status}`}>{STATUS_LABEL[w.status]}</span>
        </div>
        <span className="note wb__meta">{w.cefr} · {w.partOfSpeech} · {w.category}{w.topic ? ` · ${w.topic}` : ""}</span>
      </div>
      {w.accept.length ? <p className="note">Also accepted: {w.accept.join(", ")}</p> : null}
      {w.giverJa ? <p className="wb__ja"><span className="wb__ja-label">Japanese meaning · Giver only</span> {w.giverJa}</p> : null}
      <HintList hints={w.hints} />
      <p className="note wb__source">{source}{w.sourceId ? ` · ${w.sourceId}` : ""}</p>
      {w.status !== "archived" ? <IssueLists errors={errors} warnings={warnings} /> : null}
      <div className="wb__actions">
        {w.status !== "archived" ? <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => onEdit(w)}>Edit</button> : null}
        {w.status === "draft" ? (
          <button type="button" className="btn btn--small" disabled={busy || errors.length > 0} onClick={() => onApprove(w)} title={errors.length ? "Fix the problems first" : "Approve this word for play"}>Approve</button>
        ) : null}
        {w.status !== "archived" ? <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={() => onArchive(w)}>Archive</button> : null}
        {w.status === "archived" ? <button type="button" className="btn btn--small" disabled={busy} onClick={() => onRestore(w)}>Restore as draft</button> : null}
      </div>
    </li>
  );
}

"use client";

import { SAMPLE_SET, type VocabSet } from "@/data/vocab";
import { approvedSets } from "@/lib/studio/ops";
import type { Activity } from "@/lib/studio/types";
import type { LibraryList } from "@/lib/studio/library";
import { StudyShareControls } from "../study/StudyShare";
import { ConfirmButton, Notice, StorageNotice } from "./shared";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function StudioHome({
  activities,
  library,
  onEditList,
  onDeleteList,
  skipped,
  storageOk,
  message,
  onDismissMessage,
  onNew,
  onOpen,
  onDuplicate,
  onDelete,
  onPlay,
  onCopySample,
}: {
  activities: Activity[];
  library: LibraryList[];
  onEditList: (l: LibraryList) => void;
  onDeleteList: (l: LibraryList) => void;
  skipped: number;
  storageOk: boolean;
  message: { kind: "error" | "info"; text: string } | null;
  onDismissMessage: () => void;
  onNew: () => void;
  onOpen: (a: Activity) => void;
  onDuplicate: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  onPlay: (a: Activity) => void;
  onCopySample: () => void;
}) {
  return (
    <section className="studio-home" aria-labelledby="home-title">
      <div className="studio-head">
        <h2 id="home-title" className="studio-h">Your activities</h2>
        <button type="button" className="btn btn--hero btn--inline" onClick={onNew}>New activity</button>
      </div>

      {message ? <Notice kind={message.kind} onClose={onDismissMessage}>{message.text}</Notice> : null}
      {!storageOk ? <Notice kind="error">This browser is blocking local storage, so activities can&apos;t be saved.</Notice> : null}
      {skipped > 0 ? <Notice kind="info">{skipped} saved item{skipped === 1 ? " was" : "s were"} unreadable and ignored.</Notice> : null}

      <ul className="lineup">
        {activities.map((a) => {
          const ok = approvedSets(a).length;
          return (
            <li key={a.id} className="lineup__row">
              <div className="lineup__main">
                <h3 className="lineup__title">{a.title}</h3>
                <p className="lineup__meta">
                  {[a.brief.level, a.brief.topic, `${a.sets.length} set${a.sets.length === 1 ? "" : "s"}`, `${ok} approved`, when(a.updatedAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="lineup__actions">
                <button type="button" className="btn btn--small" onClick={() => onOpen(a)}>Open</button>
                <button type="button" className="btn btn--small btn--ghost" disabled={ok === 0} onClick={() => onPlay(a)} title={ok === 0 ? "Approve a set first" : undefined}>
                  Play
                </button>
                <button type="button" className="btn btn--small btn--ghost" onClick={() => onDuplicate(a)}>Duplicate</button>
                <ConfirmButton
                  label="Delete"
                  confirmText={`Delete “${a.title}”? This can't be undone.`}
                  confirmLabel="Delete"
                  onConfirm={() => onDelete(a)}
                />
              </div>
            </li>
          );
        })}

        <li className="lineup__row lineup__row--builtin">
          <div className="lineup__main">
            <h3 className="lineup__title">{SAMPLE_SET.title}</h3>
            <p className="lineup__meta">Built-in sample · A2–C1 · 10 words · read-only</p>
          </div>
          <div className="lineup__actions">
            <button type="button" className="btn btn--small btn--ghost" onClick={onCopySample}>Duplicate to edit</button>
          </div>
        </li>
      </ul>

      {activities.length === 0 ? (
        <p className="empty">
          Nothing saved yet. Start a new activity and describe what you want — for example, <em>“B2 vocabulary about everyday physical actions.”</em>
        </p>
      ) : null}

      <section aria-labelledby="library-title" className="library">
        <div className="libhead">
          <h2 id="library-title" className="studio-h">Vocabulary Library</h2>
          <p className="note">Every approved list you have saved. Choose any of them when you host a class.</p>
        </div>
        {library.length === 0 ? (
          <p className="empty">No approved lists yet. Approve a set (1–10 words) in an activity and it appears here.</p>
        ) : (
          <ul className="lineup">
            {library.map((l) => (
              <li key={l.key} className="lineup__row">
                <div className="lineup__main">
                  <h3 className="lineup__title">{l.title}</h3>
                  <p className="lineup__meta">{l.count} word{l.count === 1 ? "" : "s"} · {l.words.map((w) => w.word).join(", ")}</p>
                  <StudyShareControls source={l.key} title={l.title} words={l.words} />
                </div>
                <div className="lineup__actions">
                  <button type="button" className="btn btn--small" onClick={() => onEditList(l)}>Edit</button>
                  <ConfirmButton
                    label="Delete"
                    confirmText={`Delete the list “${l.title}”? This can't be undone. Your other lists aren't affected.`}
                    confirmLabel="Delete list"
                    onConfirm={() => onDeleteList(l)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>


      <StorageNotice />
    </section>
  );
}

export type { VocabSet };

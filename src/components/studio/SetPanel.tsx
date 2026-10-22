"use client";

import { useState } from "react";
import type { VocabWord } from "@/data/vocab";
import { approvalProblems, levelMix, mixAdvice } from "@/lib/studio/ops";
import { SET_SIZE, type StudioSet } from "@/lib/studio/types";
import { ConfirmButton } from "./shared";
import { WordRow } from "./WordRow";

export function SetPanel({
  sets,
  activeId,
  busy,
  busyWordId,
  canGenerate,
  onSelect,
  onAddSet,
  onRemoveSet,
  onEdit,
  onToggleLock,
  onReplace,
  onNewHints,
  onIllustrate,
  onIllustrateAll,
  onRemoveIllustration,
  onRegenerateSet,
  onFill,
  onApprove,
  onPlay,
  approveProblems,
}: {
  sets: StudioSet[];
  activeId: string | null;
  busy: string | null;
  busyWordId: string | null;
  canGenerate: boolean;
  onSelect: (id: string) => void;
  onAddSet: () => void;
  onRemoveSet: (id: string) => void;
  onEdit: (setId: string, wordId: string, patch: Partial<Omit<VocabWord, "id">>) => void;
  onToggleLock: (setId: string, wordId: string) => void;
  onReplace: (setId: string, wordId: string, instruction: string) => void;
  onNewHints: (setId: string, wordId: string, instruction: string) => void;
  onIllustrate: (setId: string, wordId: string) => void;
  onIllustrateAll: (setId: string) => void;
  onRemoveIllustration: (setId: string, wordId: string) => void;
  onRegenerateSet: (setId: string) => void;
  onFill: (setId: string) => void;
  onApprove: (setId: string) => void;
  onPlay: (setId: string) => void;
  approveProblems: string[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const set = sets.find((s) => s.id === activeId) ?? sets[0];
  const disabled = !!busy;
  const live = set ? approvalProblems(set) : [];

  return (
    <section className="pane pane--sets" aria-labelledby="sets-h">
      <h2 id="sets-h" className="pane__title">
        <span className="pane__kicker">The lineup</span>
        Review &amp; edit
      </h2>

      {sets.length === 0 ? (
        <div className="emptyset">
          <p className="emptyset__big">No words yet.</p>
          <p>Describe your activity in the writers&apos; room, then press <b>Generate</b>. Ten words appear here for you to review.</p>
        </div>
      ) : (
        <>
          <div className="settabs" role="tablist" aria-label="Vocabulary sets">
            {sets.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={s.id === set.id}
                className={`settab ${s.status === "approved" ? "is-approved" : ""}`}
                onClick={() => { onSelect(s.id); setOpenId(null); }}
              >
                {s.title}
                <span className="settab__st">{s.status === "approved" ? "✓ approved" : "draft"}</span>
              </button>
            ))}
            <button type="button" className="settab settab--add" onClick={onAddSet} disabled={!canGenerate || disabled} title={canGenerate ? "Generate another set" : "Tell the AI a topic first"}>
              + Add set
            </button>
          </div>

          <p className="mix" aria-label="Difficulty mix">
            <span className="mix__label">Mix</span>{" "}
            {(() => {
              const m = levelMix(set.words);
              return `${m.familiar} familiar · ${m.moderate} moderate · ${m.challenging} challenging`;
            })()}
            <span className="mix__note"> — a spread of levels is intentional</span>
          </p>
          {mixAdvice(set.words) ? <p className="note">{mixAdvice(set.words)}</p> : null}

          <div className="picbar">
            {(() => {
              const have = set.words.filter((w) => w.illustration).length;
              const missing = set.words.length - have;
              return (
                <>
                  <span className="note">🖼 Giver pictures: {have} of {set.words.length}. Private to the Giver — not a hint, no points lost.</span>
                  {missing > 0 ? (
                    <button type="button" className="btn btn--small" disabled={disabled || !canGenerate} onClick={() => onIllustrateAll(set.id)}>
                      Draw {missing} picture{missing === 1 ? "" : "s"} (AI)
                    </button>
                  ) : null}
                </>
              );
            })()}
          </div>

          <ol className="items">
            {set.words.map((w, i) => (
              <WordRow
                key={w.id}
                index={i}
                word={w}
                locked={set.lockedIds.includes(w.id)}
                open={openId === w.id}
                disabled={disabled}
                busyWordId={busyWordId}
                onToggleOpen={() => setOpenId(openId === w.id ? null : w.id)}
                onEdit={(patch) => onEdit(set.id, w.id, patch)}
                onToggleLock={() => onToggleLock(set.id, w.id)}
                onReplace={(ins) => onReplace(set.id, w.id, ins)}
                onNewHints={(ins) => onNewHints(set.id, w.id, ins)}
                onIllustrate={() => onIllustrate(set.id, w.id)}
                onRemoveIllustration={() => onRemoveIllustration(set.id, w.id)}
              />
            ))}
          </ol>

          {set.words.length < SET_SIZE ? (
            <p className="short">
              This set has {set.words.length} of {SET_SIZE} words.{" "}
              <button type="button" className="btn btn--small" disabled={disabled || !canGenerate} onClick={() => onFill(set.id)}>
                Ask AI for {SET_SIZE - set.words.length} more
              </button>
            </p>
          ) : null}

          <div className="setbar">
            {set.status === "approved" ? (
              <div className="approved">
                <span className="approved__stamp">✓ Approved</span>
                <button type="button" className="btn btn--hero btn--inline" onClick={() => onPlay(set.id)}>Play this set</button>
              </div>
            ) : (
              <button type="button" className="btn btn--hero btn--inline" disabled={disabled} onClick={() => onApprove(set.id)}>
                Approve this set
              </button>
            )}
            <button type="button" className="btn btn--small btn--ghost" disabled={disabled || !canGenerate} onClick={() => onRegenerateSet(set.id)}>
              Regenerate set{set.lockedIds.length ? ` (keep ${set.lockedIds.length} locked)` : ""}
            </button>
            <ConfirmButton
              label="Remove set"
              confirmText={`Remove ${set.title}?`}
              confirmLabel="Remove"
              onConfirm={() => onRemoveSet(set.id)}
            />
          </div>

          {approveProblems.length > 0 ? (
            <ul className="problems problems--block" role="alert">
              <li><b>Can&apos;t approve yet:</b></li>
              {approveProblems.map((p, i) => <li key={i} className="is-error">{p}</li>)}
            </ul>
          ) : set.status === "draft" && live.length > 0 ? (
            <p className="note">Before approving: {live.length} thing{live.length === 1 ? "" : "s"} to fix (look for ⚠).</p>
          ) : set.status === "draft" ? (
            <p className="note">Looks ready. Skim all ten, then approve — editing an approved set puts it back to draft.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

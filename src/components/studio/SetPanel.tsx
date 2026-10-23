"use client";

import { useState } from "react";
import type { VocabWord } from "@/data/vocab";
import type { Restriction } from "@/lib/studio/restrictions";
import { approvalProblems, levelMix, mixAdvice, setProgress, wordsNeedingHints } from "@/lib/studio/ops";
import { SET_SIZE, type StudioSet } from "@/lib/studio/types";
import { ConfirmButton } from "./shared";
import { WordRow } from "./WordRow";

export function SetPanel({
  sets,
  activeId,
  busy,
  restrictions = [],
  busyWordId,
  canGenerate,
  onSelect,
  onRenameSet,
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
  onReopen,
  onRetryMissing,
  onDropMissing,
  onPlay,
  approveProblems,
}: {
  sets: StudioSet[];
  activeId: string | null;
  busy: string | null;
  /** The teacher's checkable hint restrictions (from the brief). */
  restrictions?: Restriction[];
  busyWordId: string | null;
  canGenerate: boolean;
  onSelect: (id: string) => void;
  /** Name the list: it appears under this name in the Vocabulary Library. */
  onRenameSet?: (setId: string, title: string) => void;
  onAddSet: () => void;
  onRemoveSet: (id: string) => void;
  onEdit: (setId: string, wordId: string, patch: Partial<Omit<VocabWord, "id">>) => void;
  onToggleLock: (setId: string, wordId: string) => void;
  onReplace: (setId: string, wordId: string, instruction: string) => void;
  onNewHints: (setId: string, wordId: string, instruction: string, only?: number[]) => void;
  onIllustrate: (setId: string, wordId: string) => void;
  onIllustrateAll: (setId: string) => void;
  onRemoveIllustration: (setId: string, wordId: string) => void;
  onRegenerateSet: (setId: string) => void;
  onFill: (setId: string) => void;
  onApprove: (setId: string) => void;
  onReopen: (setId: string) => void;
  onRetryMissing: (setId: string, word: string) => void;
  onDropMissing: (setId: string, word: string) => void;
  onPlay: (setId: string) => void;
  approveProblems: string[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const set = sets.find((s) => s.id === activeId) ?? sets[0];
  const disabled = !!busy;
  const live = set ? approvalProblems(set, restrictions) : [];

  return (
    <section className="pane pane--sets" aria-labelledby="sets-h">
      <h2 id="sets-h" className="pane__title">
        <span className="pane__kicker">The lineup</span>
        Review &amp; edit
      </h2>

      {sets.length === 0 ? (
        <div className="emptyset">
          <p className="emptyset__big">No words yet.</p>
          <p>Describe your activity in the writers&apos; room, then press <b>Generate</b>. Your words appear here for you to review.</p>
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

          {onRenameSet ? (
            <label className="titlefld">
              <span className="note">List name (how it appears in your Vocabulary Library)</span>
              <input aria-label="List name" value={set.title} maxLength={60} onChange={(e) => onRenameSet(set.id, e.target.value)} />
            </label>
          ) : null}

          {(() => {
            const p = setProgress(set, restrictions);
            const hintWords = wordsNeedingHints(set, restrictions);
            if (set.requested === undefined && !p.needCorrection) return null;
            return (
              <div className={`progress ${p.needCorrection ? "progress--bad" : ""}`} role="status" aria-label="Generation progress">
                <p>
                  <b>{p.approved}</b> selected · <b>{p.valid}</b> valid &amp; complete · <b className={p.needCorrection ? "c-gold" : ""}>{p.needCorrection}</b> need correction
                </p>
                {hintWords.map(({ word, hints, reasons }) => (
                  <p key={word.id} className="progress__miss">
                    <b>“{word.word}”</b> — {hints.length ? `hint${hints.length === 1 ? "" : "s"} ${hints.map((h) => h + 1).join(", ")} need${hints.length === 1 ? "s" : ""} attention` : "its hints need attention"}: {reasons.join(" ")}{" "}
                    <button type="button" className="btn btn--small" disabled={disabled || !canGenerate} onClick={() => onNewHints(set.id, word.id, "", hints.length ? hints : undefined)} title="Rewrites only the hints that have a problem; hints you wrote yourself are kept">Rewrite hints</button>{" "}
                    <button type="button" className="btn btn--small btn--ghost" disabled={disabled} onClick={() => setOpenId(word.id)}>Edit hints myself</button>
                  </p>
                ))}
                {(set.missing ?? []).map((m) => (
                  <p key={m.word} className="progress__miss">
                    <b>“{m.word}”</b> has no item yet — {m.reason}{" "}
                    <button type="button" className="btn btn--small" disabled={disabled || !canGenerate} onClick={() => onRetryMissing(set.id, m.word)}>Retry this word</button>{" "}
                    <button type="button" className="btn btn--small btn--ghost" disabled={disabled} onClick={() => onDropMissing(set.id, m.word)}>Remove it from the set</button>
                  </p>
                ))}
              </div>
            );
          })()}

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
                  <span className="note">🖼 Giver pictures: {have} of {set.words.length}. Optional: during play the Giver can ask for one as a last-resort hint (score capped at 25); the game draws one on demand if none is made here.</span>
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
                restrictions={restrictions}
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
              This set has {set.words.length} word{set.words.length === 1 ? "" : "s"} (a set can hold up to {SET_SIZE}; fewer is fine).{" "}
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
                <button type="button" className="btn btn--small btn--ghost" disabled={disabled} onClick={() => onReopen(set.id)}>Reopen for editing</button>
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
            <p className="note">Looks ready. Skim every word, then approve. Once approved, a set stays exactly as it is until you reopen it.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

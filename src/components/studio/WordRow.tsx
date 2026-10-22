"use client";

import { useState } from "react";
import { CEFR_LEVELS, PARTS_OF_SPEECH, type VocabWord } from "@/data/vocab";
import { coerceJa, LIMITS, validateWord, type WordIssue } from "@/lib/studio/validation";

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
  onIllustrate: () => void;
  onRemoveIllustration: () => void;
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
  const [jaText, setJaText] = useState((w.ja ?? []).join("、"));
  const [phraseText, setPhraseText] = useState((w.giverInfo?.phrases ?? []).join("\n"));
  const panelId = `word-${w.id}`;

  const commitJa = () => p.onEdit({ ja: coerceJa(jaText) });
  const editInfo = (patch: Partial<NonNullable<VocabWord["giverInfo"]>>) => {
    const next = { ...w.giverInfo, ...patch };
    const empty = !next.looks?.trim() && !next.use?.trim() && !(next.phrases ?? []).some((x) => x.trim());
    p.onEdit({ giverInfo: empty ? undefined : next });
  };
  const commitPhrases = () => editInfo({ phrases: phraseText.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, LIMITS.phrases) });

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
          {w.illustration ? <span title="Has a Giver picture" aria-label="Has a Giver picture">🖼</span> : null}
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
            <legend>Hints — hint 1 is the free opening hint</legend>
            <p className="note">Hint 1 is shown to <b>both players automatically</b> at the start of every round and costs nothing, so make it a real situation (who, when, where) — not just “it is a kitchen tool”. Hints 2 and 3 are optional and cost points.</p>
            {[0, 1, 2].map((i) => (
              <label className="fld fld--hint" key={i}>
                <span className="hintset__n">{i + 1}</span>
                <input
                  aria-label={i === 0 ? "Hint 1 (opening hint, free)" : `Hint ${i + 1} (extra, costs points)`}
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

          <fieldset className="hintset">
            <legend>Giver notes — private help for explaining</legend>
            <label className="fld">
              <span>What it looks like <small>(objects; for actions, what you would see; leave empty for abstract words)</small></span>
              <textarea rows={2} value={w.giverInfo?.looks ?? ""} onChange={(e) => editInfo({ looks: e.target.value })} maxLength={LIMITS.giverLine} disabled={p.disabled} />
            </label>
            <label className="fld">
              <span>How it is used <small>(or when it happens / when people say it)</small></span>
              <textarea rows={2} value={w.giverInfo?.use ?? ""} onChange={(e) => editInfo({ use: e.target.value })} maxLength={LIMITS.giverLine} disabled={p.disabled} />
            </label>
            <label className="fld">
              <span>Useful language <small>(one short sentence starter per line, up to {LIMITS.phrases})</small></span>
              <textarea
                key={`${w.id}:phrases`}
                rows={3}
                value={phraseText}
                onChange={(e) => setPhraseText(e.target.value)}
                onBlur={commitPhrases}
                placeholder={"It looks like...\nYou use it when..."}
                disabled={p.disabled}
              />
            </label>
            <p className="note">Use plain English that is easier than the target word. The Giver sees these only as support — they are never read out for them.</p>
            <Problems issues={fieldIssues(issues, "giverInfo")} />
          </fieldset>

          <fieldset className="hintset">
            <legend>Japanese answers — for “I know it, but not in English!”</legend>
            <label className="fld fld--ja">
              <span>Approved Japanese equivalents <small>(comma-separated; at most {LIMITS.ja})</small></span>
              <input
                key={`${w.id}:${(w.ja ?? []).join("|")}`}
                lang="ja"
                value={jaText}
                onChange={(e) => setJaText(e.target.value)}
                onBlur={commitJa}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitJa(); } }}
                placeholder="例: ざる、水切りざる"
                disabled={p.disabled}
              />
            </label>
            <p className="note">
              A Japanese answer earns <b>half</b> the points <b>only if it matches one of these</b>. Matching is exact: hiragana/katakana, spaces and punctuation are ignored, but kanji spellings and synonyms must be listed here. Students never see this list before answering. AI suggestions are drafts — please check them. Leave empty to give no Japanese credit.
            </p>
            <Problems issues={fieldIssues(issues, "ja")} />
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

          <fieldset className="hintset picset">
            <legend>Picture for the Giver</legend>
            {w.illustration?.src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="picset__img" src={w.illustration.src} alt={w.illustration.alt ?? "Giver picture"} />
            ) : (
              <p className="note">No picture yet. The word is playable without one.</p>
            )}
            <p className="note">Only the Giver sees this, from the start of the round. It is not a hint and costs no points.</p>
            <div className="row row--left">
              <button type="button" className="btn btn--small btn--ghost" disabled={p.disabled} onClick={p.onIllustrate}>
                {w.illustration ? "Draw a new picture (AI)" : "Draw picture (AI)"}
              </button>
              {w.illustration ? (
                <button type="button" className="btn btn--small btn--ghost" disabled={p.disabled} onClick={p.onRemoveIllustration}>Remove picture</button>
              ) : null}
            </div>
          </fieldset>

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

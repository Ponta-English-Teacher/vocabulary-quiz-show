"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { clampPlayCount } from "@/lib/playCount";
import { createClassLink } from "@/lib/class/createLink";
import type { ImportReport } from "@/lib/studio/cqsImport";
import { bankCategories, bankFromText, bankLevels, clearBank, convertBank, DEFAULT_GAME_WORDS, evaluateSync, filterBank, loadBank, markSynced, MAX_GAME_WORDS, pickForGame, saveBank, type SavedBank, type SyncEvaluation } from "@/lib/studio/cqsBank";
import { downloadBackup } from "@/lib/studio/backup";
import { requestLatestBank } from "@/lib/studio/cqsSync";
import { getBrowserStorage } from "@/lib/studio/storage";
import { BankSourceSelect, DEFAULT_BANK_SOURCE, type BankSource } from "./BankSourceSelect";
import { IndependentBankPicker } from "./IndependentBankPicker";
import { QrCode } from "../QrCode";
import { TeacherPasscodeForm } from "../TeacherPasscodeForm";
import { useTeacherAccess } from "../useTeacherAccess";

/**
 * The teacher's main page: choose the Classroom Quiz Show question bank (remembered in this browser) → level and category →
 * number of questions → Start Pair Game → QR code. No activity, set, Writers' Room or approval is involved.
 */
export function BankHost() {
  const access = useTeacherAccess();
  const [bank, setBank] = useState<SavedBank | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cefr, setCefr] = useState("all");
  const [category, setCategory] = useState("all");
  const [count, setCount] = useState(DEFAULT_GAME_WORDS);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [links, setLinks] = useState<{ primary: string; others: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<Extract<SyncEvaluation, { ok: true }> | null>(null);
  /** Which bank the next game uses. Always starts as the Current Bank; it is never remembered or switched automatically. */
  const [source, setSource] = useState<BankSource>(DEFAULT_BANK_SOURCE);
  const [indepCount, setIndepCount] = useState<number | null>(null);

  useEffect(() => {
    setBank(loadBank(getBrowserStorage()));
    setLoaded(true);
  }, []);

  const report: ImportReport | null = useMemo(() => (bank ? convertBank(bank) : null), [bank]);
  const pool = useMemo(() => (report ? filterBank(report, { cefr, category }) : { ready: [], flagged: [] }), [report, cefr, category]);
  const levels = useMemo(() => (report ? bankLevels(report) : []), [report]);
  const categories = useMemo(() => (report ? bankCategories(report) : []), [report]);
  const ticked = pool.flagged.filter((i) => chosen.has(i.sourceId)).length;
  const available = pool.ready.length + ticked;
  const playCount = clampPlayCount(count, Math.min(MAX_GAME_WORDS, Math.max(1, available)));
  const reset = () => setLinks(null);

  const load = async (file: File | undefined) => {
    setError(null);
    setNotice(null);
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("The file could not be read. Your previous bank (if any) is unchanged.");
      return;
    }
    const r = bankFromText(getBrowserStorage(), file.name, text);
    if (!r.ok) {
      setError(`${r.error} Your previous bank (if any) is unchanged.`);
      return;
    }
    setPending(null);
    setBank(r.bank);
    setCefr("all");
    setCategory("all");
    setChosen(new Set());
    setLinks(null);
    setNotice(r.remembered ? "Question bank loaded and remembered in this browser." : "Question bank loaded, but this browser would not remember it: choose the file again next time.");
    if (fileRef.current) fileRef.current.value = "";
  };

  const when = (iso?: string) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "an unknown time";
  };

  const accept = (incoming: SavedBank) => {
    const remembered = saveBank(getBrowserStorage(), incoming);
    setBank(incoming);
    setCefr("all");
    setCategory("all");
    setChosen(new Set());
    setLinks(null);
    setPending(null);
    const c = convertBank(incoming).counts;
    setNotice(`Synced ${c.total} approved questions from Classroom Quiz Show: ${c.ready} ready, ${c.flagged} flagged, ${c.skipped} skipped.${remembered ? "" : " This browser would not remember them: sync again next time."}`);
  };

  const sync = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    setPending(null);
    const r = await requestLatestBank(bank?.origin === "sync" ? bank.etag : undefined);
    setSyncing(false);
    const keep = bank ? ` Still using your saved bank${bank.origin === "sync" ? ` (last synced ${when(bank.syncedAt)})` : ""}.` : " You can choose a file instead.";
    if (r.kind === "error") {
      setError(`Sync failed: ${r.message}${keep}`);
      return;
    }
    if (r.kind === "unchanged") {
      if (!bank) {
        setError(`Sync failed: nothing was received.${keep}`);
        return;
      }
      const m = markSynced(getBrowserStorage(), bank);
      setBank(m.bank);
      setNotice(`Already up to date (checked ${when(m.bank.syncedAt)}).`);
      return;
    }
    const ev = evaluateSync(bank, r.text, r.etag);
    if (!ev.ok) {
      setError(`Sync failed: ${ev.error}${keep}`);
      return;
    }
    if (ev.needsConfirm) {
      setPending(ev);
      return;
    }
    accept(ev.incoming);
  };

  const backup = () => {
    setError(null);
    const r = downloadBackup(getBrowserStorage());
    const c = r.summary;
    if (!r.ok) setError("The backup could not be downloaded by this browser. Nothing was changed.");
    else setNotice(`Backup downloaded (${r.filename}): ${c.bankQuestions} bank questions (${c.bankReady} ready, ${c.bankFlagged} flagged, ${c.bankSkipped} skipped) and ${c.activities} saved ${c.activities === 1 ? "activity" : "activities"} with ${c.words} words. Nothing in this browser was changed.`);
  };

  const forget = () => {
    const s = getBrowserStorage();
    if (s) clearBank(s);
    setBank(null);
    setChosen(new Set());
    setLinks(null);
    setNotice("The saved question bank was removed from this browser. Your original file is untouched.");
  };

  const start = async () => {
    if (!report || available < 1) return;
    setBusy(true);
    setError(null);
    const pick = pickForGame(pool, playCount, chosen);
    const label = [cefr === "all" ? "All levels" : cefr, category === "all" ? "all categories" : category].join(" · ");
    const r = await createClassLink(`Pair game — ${label}`.slice(0, 100), pick.words);
    setBusy(false);
    if (r.ok) setLinks(r.links);
    else setError(r.message);
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setCopied(null);
    }
  };

  const fileInput = (label: string, primary: boolean) => (
    <label className={primary ? "btn btn--hero bankhost__file" : "btn btn--small btn--ghost bankhost__file"}>
      {label}
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void load(e.target.files?.[0])} />
    </label>
  );

  if (!loaded) return <p className="note">Loading…</p>;

  return (
    <div className="bankhost">
      {access.status === "needs" ? (
        <div className="bankhost__unlock">
          <p className="note">Enter the teacher passcode to sync the bank and start games.</p>
          <TeacherPasscodeForm error={access.error} busy={access.busy} onSubmit={access.submit} />
        </div>
      ) : access.status === "locked" ? (
        <p className="note" role="alert">Teacher tools are locked: no teacher passcode is configured on this server.</p>
      ) : null}
      <BankSourceSelect
        source={source}
        currentCount={report ? report.counts.total : null}
        independentCount={indepCount}
        onChange={(next) => { setSource(next); setLinks(null); if (next === "independent") { setError(null); setNotice(null); } }}
      />
      {source === "independent" ? (
        <IndependentBankPicker allowed={access.allowed} onLinks={setLinks} onCount={setIndepCount} />
      ) : (
      <>
      <h3 className="bankhost__step">1. Question bank</h3>
      <button type="button" className="btn btn--hero" onClick={sync} disabled={syncing || !access.allowed}>
        {syncing ? "Syncing…" : "Sync Latest Bank"}
      </button>
      <p className="note">Gets the latest approved questions straight from Classroom Quiz Show. Your saved bank is kept if anything goes wrong.</p>
      {pending ? (
        <div className="bankhost__confirm" role="alertdialog" aria-label="Confirm a smaller bank">
          <p className="feedback feedback--wrong">
            The new bank has only <b>{pending.readyAfter}</b> ready questions, down from <b>{pending.readyBefore}</b> (more than half fewer). That may be a mistake. Replace your saved bank?
          </p>
          <div className="bankhost__actions">
            <button type="button" className="btn btn--small" onClick={() => accept(pending.incoming)}>Replace anyway</button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => { setPending(null); setNotice("Kept your saved bank. The smaller one was not used."); }}>Keep my saved bank</button>
          </div>
        </div>
      ) : null}
      {!bank || !report ? (
        <>
          <p className="note">No question bank saved in this browser yet. Press Sync Latest Bank, or choose an exported file instead.</p>
          {fileInput("Or choose a file instead…", false)}
        </>
      ) : (
        <>
          <p className="bankhost__bank">
            <b>{bank.origin === "sync" ? "Classroom Quiz Show (synced)" : bank.fileName}</b>
            <span>{bank.origin === "sync" ? `Last synced ${when(bank.syncedAt)}` : `Loaded from a file ${when(bank.savedAt)} (not synced)`}</span>
            <span>{report.counts.total} questions in this bank</span>
            <span className="bankhost__counts" role="status">
              <span className="c-good">{report.counts.ready} ready</span> · <span className="c-gold">{report.counts.flagged} flagged</span> · <span>{report.counts.skipped} skipped</span>
            </span>
          </p>
          <div className="bankhost__actions">
            {fileInput("Replace from a file…", false)}
            <button type="button" className="btn btn--small btn--ghost" onClick={forget}>Remove saved bank</button>
          </div>
          <details className="fold">
            <summary>What do ready, flagged and skipped mean?</summary>
            <p className="note"><b>Ready</b> questions are used automatically. <b>Flagged</b> ones are probably awkward to explain aloud (names, titles, picture clues…) and are only used if you tick them below. <b>Skipped</b> ones cannot be used (not approved, repeated, or fewer than three clean clues).</p>
            {report.items.some((i) => i.status === "skipped") ? (
              <ul className="cqs__skipped">
                {report.items.filter((i) => i.status === "skipped").slice(0, 40).map((i) => <li key={`${i.sourceId}-${i.label}`}><b>{i.label}</b> <span className="note">{i.reasons.join(" ")}</span></li>)}
              </ul>
            ) : null}
          </details>

          <h3 className="bankhost__step">2. Level and category</h3>
          <div className="cqs__filters">
            <label className="field"><span className="field__label">Level</span>
              <select className="setselect" value={cefr} onChange={(e) => { setCefr(e.target.value); reset(); }}>
                <option value="all">All levels</option>
                {levels.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label className="field"><span className="field__label">Category</span>
              <select className="setselect" value={category} onChange={(e) => { setCategory(e.target.value); reset(); }}>
                <option value="all">All categories</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <p className="note" role="status">
            <b>{pool.ready.length}</b> ready question{pool.ready.length === 1 ? "" : "s"} match{pool.ready.length === 1 ? "es" : ""}
            {pool.flagged.length ? <> · {pool.flagged.length} flagged (not used unless ticked){ticked ? `, ${ticked} ticked` : ""}</> : null}
          </p>
          {pool.flagged.length ? (
            <details className="fold">
              <summary>Flagged questions that match ({pool.flagged.length}): tick any you want to use</summary>
              <ul className="cqs__list">
                {pool.flagged.slice(0, 100).map((i) => (
                  <li key={i.sourceId} className="cqs__row cqs__row--flagged">
                    <label className="cqs__pick">
                      <input type="checkbox" checked={chosen.has(i.sourceId)} onChange={() => { setChosen((p) => { const n = new Set(p); if (n.has(i.sourceId)) n.delete(i.sourceId); else n.add(i.sourceId); return n; }); reset(); }} aria-label={`Use ${i.label}`} />
                      <span className="cqs__word">{i.word?.word}</span>
                      <span className="note">{i.cefr} · {i.category}</span>
                    </label>
                    <p className="cqs__why">⚠ {i.reasons.join(" ")}</p>
                  </li>
                ))}
              </ul>
              {pool.flagged.length > 100 ? <p className="note">Showing the first 100 flagged questions. Narrow the level or category to see the rest.</p> : null}
            </details>
          ) : null}

          <h3 className="bankhost__step">3. Number of questions</h3>
          {available > 0 ? (
            <label className="field playcount">
              <span className="field__label">Number of questions</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_GAME_WORDS}
                step={1}
                value={count}
                onChange={(e) => { const v = Math.floor(Number(e.target.value)); setCount(Number.isFinite(v) && v >= 1 ? Math.min(v, MAX_GAME_WORDS) : 1); reset(); }}
              />
              <span className="note">{available} usable · the game will have {playCount}</span>
            </label>
          ) : (
            <p className="feedback feedback--wrong" role="alert">No usable questions match this level and category. Choose another, or tick flagged questions above.</p>
          )}
          {available > 0 && count > available ? (
            <p className="note" role="status">You asked for {count}, but only {available} usable question{available === 1 ? "" : "s"} match, so the game will have {Math.min(available, MAX_GAME_WORDS)}. Choose “All levels” or “All categories” for more.</p>
          ) : null}
          {available > MAX_GAME_WORDS ? <p className="note">A game can have at most {MAX_GAME_WORDS} questions.</p> : null}

          <h3 className="bankhost__step">4. Start</h3>
          <button type="button" className="btn btn--hero" onClick={start} disabled={busy || available < 1 || !access.allowed}>
            {busy ? "Creating…" : "Start Pair Game"}
          </button>
        </>
      )}
      <details className="fold">
        <summary>Backup</summary>
        <p className="note">Downloads everything saved in this browser (the question bank with its ready/flagged/skipped report, and any saved Studio activities) as one JSON file. It only reads: nothing is changed or removed, and the teacher passcode is not included. Keep the file somewhere safe.</p>
        <button type="button" className="btn btn--small btn--ghost" onClick={backup}>Export Backup</button>
      </details>
      </>
      )}
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
      {notice ? <p className="note" role="status">{notice}</p> : null}
      {links ? (
        <div className="hostclass__links" role="status">
          <QrCode url={links.primary} />
          <p className="note"><b>Students:</b> scan this code (or open the link) on your phone, enter a name and a group number. Two students with the same group number play together. Keep this page open while they play.</p>
          {[links.primary, ...links.others].map((u) => (
            <p key={u} className="hostclass__url">
              <a href={u}>{u}</a>
              <button type="button" className="btn btn--small btn--ghost" onClick={() => copy(u)}>{copied === u ? "Copied ✓" : "Copy"}</button>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

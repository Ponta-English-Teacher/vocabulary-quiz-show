"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clampPlayCount } from "@/lib/playCount";
import { makeApi } from "@/lib/bank/client";
import { DEFAULT_BANK_GAME_WORDS, MAX_BANK_GAME_WORDS, categoriesIn, filterPlayable, levelsIn, loadIndependent, pickIndependent, unavailableMessage, type IndependentLoad } from "@/lib/bank/play";
import { createClassLink } from "@/lib/class/createLink";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";

type Load = { kind: "loading" } | IndependentLoad;

/**
 * Start a Pair Game from the independent Word Bank. Only APPROVED words are loaded (read-only request). If the bank is unavailable or empty
 * the teacher sees a clear message: the Current Bank is never used instead. Gameplay, scoring and hints are the same as for any bank.
 */
export function IndependentBankPicker({ allowed, onLinks, onCount }: {
  allowed: boolean;
  onLinks: (links: { primary: string; others: string[] } | null) => void;
  /** Reports how many approved words were loaded (for the selector label). */
  onCount?: (n: number | null) => void;
}) {
  const api = useMemo(() => makeApi({ headers: teacherHeaders, onUnauthorized: clearPasscode }), []);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [cefr, setCefr] = useState("all");
  const [category, setCategory] = useState("all");
  const [count, setCount] = useState(DEFAULT_BANK_GAME_WORDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    setError(null);
    onLinks(null);
    const r = await loadIndependent(api);
    setLoad(r);
    onCount?.(r.kind === "ready" ? r.playable.words.length : null);
  }, [api, onLinks, onCount]);

  useEffect(() => { if (allowed) void refresh(); }, [allowed, refresh]);

  if (!allowed) return <p className="note">Enter the teacher passcode above to load the independent Word Bank.</p>;
  if (load.kind === "loading") return <p className="note" role="status">Loading approved words from the independent Word Bank…</p>;
  if (load.kind === "error") {
    return (
      <div className="bankhost__confirm" role="alert">
        <p className="feedback feedback--wrong">{load.message}</p>
        <div className="bankhost__actions"><button type="button" className="btn btn--small" onClick={refresh}>Try again</button></div>
      </div>
    );
  }

  const { words, excluded } = load.playable;
  if (words.length === 0) {
    return (
      <div className="bankhost__confirm" role="alert">
        <p className="feedback feedback--wrong">{unavailableMessage("empty")}</p>
        <div className="bankhost__actions"><button type="button" className="btn btn--small btn--ghost" onClick={refresh}>Check again</button></div>
      </div>
    );
  }

  const pool = filterPlayable(words, { cefr, category });
  const available = pool.length;
  const playCount = clampPlayCount(count, Math.min(MAX_BANK_GAME_WORDS, Math.max(1, available)));
  const levels = levelsIn(words);
  const categories = categoriesIn(words);

  const start = async () => {
    if (available < 1) return;
    setBusy(true);
    setError(null);
    const pick = pickIndependent(pool, playCount);
    const label = ["Independent bank", cefr === "all" ? "all levels" : cefr, category === "all" ? "all categories" : category].join(" · ");
    const r = await createClassLink(`Pair game — ${label}`.slice(0, 100), pick.words);
    setBusy(false);
    if (r.ok) onLinks(r.links);
    else setError(r.message);
  };

  return (
    <div className="bankhost__independent">
      <p className="bankhost__bank">
        <b>Independent VQS Word Bank</b>
        <span>{words.length} approved word{words.length === 1 ? "" : "s"} loaded from the server (approved words only)</span>
        {excluded ? <span className="c-gold">{excluded} approved word{excluded === 1 ? "" : "s"} skipped because they no longer pass the checks</span> : null}
      </p>
      <h3 className="bankhost__step">2. Level and category</h3>
      <div className="cqs__filters">
        <label className="field"><span className="field__label">Level</span>
          <select className="setselect" value={cefr} onChange={(e) => { setCefr(e.target.value); onLinks(null); }}>
            <option value="all">All levels</option>{levels.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        <label className="field"><span className="field__label">Category</span>
          <select className="setselect" value={category} onChange={(e) => { setCategory(e.target.value); onLinks(null); }}>
            <option value="all">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <p className="note" role="status"><b>{available}</b> approved word{available === 1 ? "" : "s"} match</p>
      <h3 className="bankhost__step">3. Number of questions</h3>
      {available > 0 ? (
        <label className="field playcount">
          <span className="field__label">Number of questions</span>
          <input type="number" inputMode="numeric" min={1} max={MAX_BANK_GAME_WORDS} step={1} value={count}
            onChange={(e) => { const v = Math.floor(Number(e.target.value)); setCount(Number.isFinite(v) && v >= 1 ? Math.min(v, MAX_BANK_GAME_WORDS) : 1); onLinks(null); }} />
          <span className="note">{available} usable · the game will have {playCount}</span>
        </label>
      ) : (
        <p className="feedback feedback--wrong" role="alert">{unavailableMessage("nomatch")}</p>
      )}
      {available > 0 && count > available ? <p className="note" role="status">You asked for {count}, but only {available} approved word{available === 1 ? "" : "s"} match, so the game will have {available}.</p> : null}
      <h3 className="bankhost__step">4. Start</h3>
      <button type="button" className="btn btn--hero" onClick={start} disabled={busy || available < 1}>{busy ? "Creating…" : "Start Pair Game"}</button>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
    </div>
  );
}

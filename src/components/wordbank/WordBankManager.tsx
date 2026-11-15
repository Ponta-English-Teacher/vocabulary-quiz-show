"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { makeApi, type Counts } from "@/lib/bank/client";
import type { BankWord } from "@/lib/bank/types";
import { DEFAULT_FILTERS, STATUS_LABEL, archivableDrafts, archiveConfirmMessage, blankForm, canApprove, categoriesOf, filterWords, formFromWord, levelsOf, payloadFromForm, workflowSummary, type Filters, type WordForm } from "@/lib/bank/view";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { TeacherPasscodeForm } from "../TeacherPasscodeForm";
import { useTeacherAccess } from "../useTeacherAccess";
import { ImportPanel } from "./ImportPanel";
import { ToolsPanel } from "./ToolsPanel";
import { WordCard } from "./WordCard";
import { WordEditor } from "./WordEditor";

type Tab = "review" | "import" | "create" | "tools";
const PAGE = 40;
const ZERO: Counts = { draft: 0, approved: 0, archived: 0, total: 0 };

/**
 * The independent Vocabulary Quiz Show Word Bank (teacher only). Import → Review → Edit → Approve.
 * It does not feed gameplay yet: games still use the browser bank. Nothing here approves or generates words by itself.
 */
export function WordBankManager() {
  const access = useTeacherAccess();
  const api = useMemo(() => makeApi({ headers: teacherHeaders, onUnauthorized: clearPasscode }), []);
  const [tab, setTab] = useState<Tab>("review");
  const [words, setWords] = useState<BankWord[]>([]);
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [loaded, setLoaded] = useState(false);
  const [unreadable, setUnreadable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<BankWord | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    const r = await api.list();
    if (!r.ok) { setError(r.message); setLoaded(true); return; }
    setError(null);
    setWords(r.data.words);
    setCounts(r.data.counts);
    setUnreadable(r.data.unreadable);
    setLoaded(true);
  }, [api]);

  useEffect(() => { if (access.allowed) void load(); }, [access.allowed, load]);

  const visible = useMemo(() => filterWords(words, filters), [words, filters]);
  const approvable = useMemo(() => visible.filter(canApprove), [visible]);
  const chosen = useMemo(() => words.filter((w) => selected.has(w.id) && canApprove(w)), [words, selected]);
  const drafts = useMemo(() => visible.filter((w) => w.status === "draft"), [visible]);
  const archivable = useMemo(() => archivableDrafts(words, selected), [words, selected]);
  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => { setFilters((p) => ({ ...p, [k]: v })); setShown(PAGE); };

  const replace = (w: BankWord) => setWords((p) => p.map((x) => (x.id === w.id ? w : x)));
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(null); setNotice(null); await fn(); setBusy(false); };

  const approve = (w: BankWord) => act(async () => {
    const r = await api.approve(w.id);
    if (!r.ok) return setError(`“${w.word}”: ${r.message}`);
    await load();
    setNotice(`Approved “${w.word}”.`);
  });
  const archive = (w: BankWord) => act(async () => {
    const r = await api.archive(w.id);
    if (!r.ok) return setError(r.message);
    await load();
    setNotice(`Archived “${w.word}”. You can restore it later (it comes back as a draft).`);
  });
  const restore = (w: BankWord) => act(async () => {
    const r = await api.restore(w.id);
    if (!r.ok) return setError(r.message);
    await load();
    setNotice(`Restored “${w.word}” as a draft. Review and approve it again.`);
  });
  const approveSelected = () => act(async () => {
    const r = await api.approveMany(chosen.map((w) => w.id));
    if (!r.ok) return setError(r.message);
    await load();
    setSelected(new Set());
    setNotice(`Approved ${r.data.approved.length} word${r.data.approved.length === 1 ? "" : "s"}.${r.data.failed.length ? ` ${r.data.failed.length} could not be approved: ${r.data.failed.slice(0, 3).map((f) => f.message).join(" ")}` : ""}`);
  });

  const archiveSelected = () => {
    const n = archivable.length;
    if (!n) return;
    // Exact number in the confirmation. Cancelling changes nothing.
    if (typeof window !== "undefined" && !window.confirm(archiveConfirmMessage(n))) return;
    void act(async () => {
      const r = await api.archiveDrafts(archivable.map((w) => w.id));
      if (!r.ok) { await load(); return setError(r.message); }
      await load(); // refreshes the draft and archived counts
      setSelected(new Set());
      setNotice(`Archived ${r.data.archived.length} draft${r.data.archived.length === 1 ? "" : "s"}. They can be restored from the Archived list (they come back as drafts).`);
    });
  };

  const saveEdit = (form: WordForm) => act(async () => {
    if (!editing) return;
    setEditError(null);
    const r = await api.edit(editing.id, payloadFromForm(form));
    if (!r.ok) return setEditError(r.message);
    replace(r.data.word);
    setEditing(null);
    await load();
    setNotice(`Saved “${r.data.word.word}” as a draft. Approve it when you are happy with it.`);
  });
  const createWord = (form: WordForm) => act(async () => {
    setEditError(null);
    const r = await api.create(payloadFromForm(form));
    if (!r.ok) return setEditError(r.message);
    await load();
    setNotice(`Created “${r.data.word.word}” as a draft. Open the Review tab to check and approve it.`);
    setFilters((p) => ({ ...p, status: "draft" }));
    setTab("review");
  });

  if (access.status === "loading") return <p className="note">Loading…</p>;
  if (access.status === "needs") return <div className="wb wb--gate"><p className="note">Enter the teacher passcode to open the Word Bank.</p><TeacherPasscodeForm error={access.error} busy={access.busy} onSubmit={access.submit} /></div>;
  if (access.status === "locked") return <p className="note" role="alert">The Word Bank is locked: no teacher passcode is configured on this server.</p>;

  const steps = workflowSummary(counts);
  const tabs: [Tab, string][] = [["review", "Review"], ["import", "Import"], ["create", "New word"], ["tools", "Template · Prompt · Export"]];

  return (
    <div className="wb">
      <header className="wb__header">
        <h1 className="wb__h1">Word Bank</h1>
        <p className="note">The independent Vocabulary Quiz Show bank. Games do not use it yet — they still use the saved browser bank. <a href="/">Back to the start page</a></p>
        <ol className="wb__steps" aria-label="Workflow">
          {steps.map((s, i) => (
            <li key={s.step} className="wb__step">
              <button type="button" className="wb__step-btn" onClick={() => setTab(i === 0 ? "import" : "review")}><b>{s.step}</b><span>{s.text}</span></button>
            </li>
          ))}
        </ol>
      </header>

      <nav className="wb__tabs" role="tablist" aria-label="Word Bank sections">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`wb__tab${tab === id ? " wb__tab--on" : ""}`} onClick={() => { setTab(id); setEditError(null); }}>{label}</button>)}
      </nav>

      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
      {notice ? <p className="wb__notice" role="status">{notice}</p> : null}
      {unreadable ? <p className="note" role="alert">{unreadable} stored record{unreadable === 1 ? " was" : "s were"} unreadable and {unreadable === 1 ? "is" : "are"} not shown. Nothing was deleted.</p> : null}

      {tab === "import" ? <ImportPanel api={api} onImported={() => { void load(); setFilters((p) => ({ ...p, status: "draft" })); }} /> : null}
      {tab === "tools" ? <ToolsPanel api={api} words={words} /> : null}
      {tab === "create" ? (
        <section className="wb__panel">
          <h2 className="wb__h2">Write a new word</h2>
          <WordEditor key="new" title="New word" initial={blankForm()} submitLabel="Save as draft" busy={busy} serverError={editError} note="Write it yourself — no AI is used. You can leave hints unfinished and come back later." onSubmit={createWord} />
        </section>
      ) : null}

      {tab === "review" ? (
        <section className="wb__panel">
          <h2 className="wb__h2">Review words</h2>
          <div className="wb__stats" role="group" aria-label="Counts">
            {(["draft", "approved", "archived"] as const).map((s) => (
              <button key={s} type="button" className={`wb__stat${filters.status === s ? " wb__stat--on" : ""}`} onClick={() => setFilter("status", s)}><b>{counts[s]}</b><span>{STATUS_LABEL[s]}</span></button>
            ))}
            <button type="button" className={`wb__stat${filters.status === "all" ? " wb__stat--on" : ""}`} onClick={() => setFilter("status", "all")}><b>{counts.total}</b><span>All</span></button>
          </div>
          <div className="wb__grid wb__filters">
            <label className="field"><span className="field__label">Search</span><input type="search" value={filters.q} onChange={(e) => setFilter("q", e.target.value)} placeholder="word, category, Japanese…" /></label>
            <label className="field"><span className="field__label">Level</span>
              <select className="setselect" value={filters.cefr} onChange={(e) => setFilter("cefr", e.target.value as Filters["cefr"])}><option value="all">All levels</option>{levelsOf(words).map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
            <label className="field"><span className="field__label">Category</span>
              <select className="setselect" value={filters.category} onChange={(e) => setFilter("category", e.target.value)}><option value="all">All categories</option>{categoriesOf(words).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          </div>

          {editing ? (
            <WordEditor key={editing.id} title={`Edit “${editing.word}”`} initial={formFromWord(editing)} submitLabel="Save changes" busy={busy} serverError={editError} note={editing.status === "approved" ? "This word is approved. Saving changes returns it to draft, so you will approve it again." : undefined} onSubmit={saveEdit} onCancel={() => { setEditing(null); setEditError(null); }} />
          ) : null}

          {filters.status === "draft" || filters.status === "all" ? (
            <div className="wb__bulk">
              <button type="button" className="btn btn--small btn--ghost" disabled={busy || !approvable.length} onClick={() => setSelected(new Set(approvable.slice(0, 200).map((w) => w.id)))}>Select all {Math.min(approvable.length, 200)} approvable drafts shown</button>
              <button type="button" className="btn btn--small btn--ghost" disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
              <button type="button" className="btn btn--small btn--ghost" disabled={busy || !drafts.length} onClick={() => setSelected(new Set(drafts.slice(0, 200).map((w) => w.id)))}>Select all {Math.min(drafts.length, 200)} drafts shown</button>
              <button type="button" className="btn btn--small" disabled={busy || !chosen.length} onClick={approveSelected}>Approve selected ({chosen.length})</button>
              <button type="button" className="btn btn--small wb__danger" disabled={busy || !archivable.length} onClick={archiveSelected}>Archive Selected Drafts ({archivable.length})</button>
            </div>
          ) : null}
          <p className="note" role="status">{visible.length} word{visible.length === 1 ? "" : "s"} match.{filters.status === "draft" ? " Only drafts without errors can be approved; you decide which." : ""}</p>

          {!loaded ? <p className="note">Loading the bank…</p> : visible.length === 0 ? (
            <p className="note">{counts.total === 0 ? "The bank is empty. Use Import or New word to add your first words." : "No words match these filters."}</p>
          ) : (
            <ul className="wb__list">
              {visible.slice(0, shown).map((w) => (
                <WordCard key={w.id} word={w} selected={selected.has(w.id)} busy={busy}
                  onSelect={(id, on) => setSelected((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; })}
                  onEdit={(x) => { setEditing(x); setEditError(null); window.scrollTo?.({ top: 0, behavior: "smooth" }); }} onApprove={approve} onArchive={archive} onRestore={restore} />
              ))}
            </ul>
          )}
          {visible.length > shown ? <button type="button" className="btn btn--small btn--ghost" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more</button> : null}
        </section>
      ) : null}
    </div>
  );
}

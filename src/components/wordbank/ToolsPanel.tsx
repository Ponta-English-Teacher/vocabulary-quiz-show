"use client";

import { useMemo, useState } from "react";
import { CEFR_LEVELS, type CefrLevel } from "@/data/vocab";
import type { WordbankApi } from "@/lib/bank/client";
import { buildGenerationPrompt, templateFile } from "@/lib/bank/template";
import type { BankWord } from "@/lib/bank/types";
import { downloadText } from "@/lib/bank/view";

/** Template, copy-paste prompt (for ChatGPT, Claude or by hand — this app calls no AI) and the complete export. */
export function ToolsPanel({ api, words }: { api: WordbankApi; words: readonly BankWord[] }) {
  const [level, setLevel] = useState<CefrLevel | "Mixed">("B1");
  const [topic, setTopic] = useState("");
  const [size, setSize] = useState(20);
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [giverJa, setGiverJa] = useState(true);
  const [avoid, setAvoid] = useState(true);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const prompt = useMemo(
    () => buildGenerationPrompt({ level, topic, size, format, giverJa, existingWords: avoid ? words.filter((w) => w.status !== "archived").map((w) => w.word) : [] }),
    [level, topic, size, format, giverJa, avoid, words],
  );

  const template = (fmt: "json" | "csv") => {
    const t = templateFile(fmt);
    setMsg(downloadText(t.filename, t.mime, t.content) ? `Downloaded ${t.filename}.` : "Your browser could not download the file.");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); } catch { setCopied(false); setMsg("Copy did not work: select the text and copy it by hand."); }
  };
  const exportAll = async () => {
    setBusy(true);
    setMsg(null);
    const r = await api.exportAll();
    setBusy(false);
    if (!r.ok) return setMsg(r.message);
    setMsg(downloadText(r.data.filename, "application/json", r.data.text) ? `Downloaded ${r.data.filename} — the complete word bank (every status).` : "Your browser could not download the file.");
  };

  return (
    <section className="wb__panel">
      <h2 className="wb__h2">Template, prompt and export</h2>

      <h3 className="wb__h3">1. Template</h3>
      <p className="note">A small example file in the exact format the importer reads: four hints per word, from least to most helpful.</p>
      <div className="wb__actions">
        <button type="button" className="btn btn--small" onClick={() => template("json")}>Download JSON template</button>
        <button type="button" className="btn btn--small" onClick={() => template("csv")}>Download CSV template</button>
      </div>

      <h3 className="wb__h3">2. Question-writing prompt</h3>
      <p className="note">Copy this into ChatGPT or Claude yourself, then save its answer as a file and import it. This app does not call any AI and never generates words on its own.</p>
      <div className="wb__grid">
        <label className="field"><span className="field__label">Level</span>
          <select className="setselect" value={level} onChange={(e) => { setLevel(e.target.value as CefrLevel | "Mixed"); setCopied(false); }}>
            <option value="Mixed">Mixed levels</option>{CEFR_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        <label className="field"><span className="field__label">Topic (optional)</span>
          <input value={topic} maxLength={120} onChange={(e) => { setTopic(e.target.value); setCopied(false); }} placeholder="Kitchen tools" /></label>
        <label className="field"><span className="field__label">How many words</span>
          <input type="number" inputMode="numeric" min={1} max={100} value={size} onChange={(e) => { setSize(Math.min(100, Math.max(1, Math.floor(Number(e.target.value)) || 1))); setCopied(false); }} /></label>
        <label className="field"><span className="field__label">File format</span>
          <select className="setselect" value={format} onChange={(e) => { setFormat(e.target.value as "json" | "csv"); setCopied(false); }}><option value="json">JSON</option><option value="csv">CSV</option></select></label>
      </div>
      <label className="wb__keep"><input type="checkbox" checked={giverJa} onChange={(e) => { setGiverJa(e.target.checked); setCopied(false); }} /> Ask for a Japanese meaning for the Giver</label>
      <label className="wb__keep"><input type="checkbox" checked={avoid} onChange={(e) => { setAvoid(e.target.checked); setCopied(false); }} /> Ask it to avoid the {words.filter((w) => w.status !== "archived").length} words already in the bank</label>
      <textarea className="wb__prompt" readOnly rows={10} value={prompt} aria-label="Question-writing prompt" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn btn--small" onClick={copy}>{copied ? "Copied ✓" : "Copy prompt"}</button>

      <h3 className="wb__h3">3. Export the complete bank</h3>
      <p className="note">Downloads every word (drafts, approved and archived) with its hints, Japanese meaning, source and source ID. The file can be imported again.</p>
      <button type="button" className="btn btn--small" disabled={busy} onClick={exportAll}>{busy ? "Preparing…" : "Export complete bank"}</button>
      {msg ? <p className="note" role="status">{msg}</p> : null}
    </section>
  );
}

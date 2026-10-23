"use client";

import { useEffect, useState } from "react";
import { SAMPLE_SET } from "@/data/vocab";
import { libraryLists, type LibraryList } from "@/lib/studio/library";
import { getBrowserStorage, loadActivities } from "@/lib/studio/storage";
import { pickClassroomUrls } from "@/lib/class/url";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { clampPlayCount, DEFAULT_PLAY_COUNT, selectWords } from "@/lib/playCount";
import { PlayCount } from "../PlayCount";
import { QrCode } from "../QrCode";
import { TeacherPasscodeForm } from "../TeacherPasscodeForm";
import { useTeacherAccess } from "../useTeacherAccess";

/** "preset", or the key of a Vocabulary Library list. The teacher must choose explicitly. */
type Choice = string;

/** Teacher: choose an activity, publish it for a class, and get the link and a QR code students scan with their phones. */
export function HostClass() {
  const access = useTeacherAccess();
  // The Vocabulary Library: every approved list in this browser's saved Studio activities (re-read on mount and on tab focus).
  const [lists, setLists] = useState<LibraryList[]>([]);
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => {
    const read = () => setLists(libraryLists(loadActivities(getBrowserStorage()).activities).filter((l) => l.ready));
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  const chosen = choice && choice !== "preset" ? lists.find((l) => l.key === choice) ?? null : null;
  const set = choice === "preset" ? SAMPLE_SET : chosen ? { title: chosen.title, words: chosen.words } : null;
  const available = set?.words.length ?? 0;
  const [count, setCount] = useState(DEFAULT_PLAY_COUNT);
  const playCount = clampPlayCount(count, available || DEFAULT_PLAY_COUNT);
  const [links, setLinks] = useState<{ primary: string; others: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const create = async () => {
    if (!set) return;
    setBusy(true);
    setError(null);
    const picked = selectWords(set.words, playCount);
    try {
      const res = await fetch("/api/class", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...teacherHeaders() },
        body: JSON.stringify({ set: { title: set.title, words: picked } }),
      });
      const j = await res.json();
      if (res.status === 401) clearPasscode();
      if (!j.ok) throw new Error(j.error?.message ?? "Could not create the class link.");
      setLinks(pickClassroomUrls({ origin: window.location.origin, hostname: window.location.hostname, path: j.path, lanUrls: j.lanUrls ?? [] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the class link.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setCopied(null);
    }
  };

  if (access.status === "needs") return <TeacherPasscodeForm error={access.error} busy={access.busy} onSubmit={access.submit} />;
  if (access.status === "locked") return <p className="note" role="alert">Hosting is locked: no teacher passcode is configured on this server.</p>;

  return (
    <div className="hostclass">
      <fieldset className="hostclass__choose">
        <legend className="field__label">Choose an Activity</legend>
        <label className="hostclass__opt">
          <input type="radio" name="host-activity" checked={choice === "preset"} onChange={() => { setChoice("preset"); setCount(DEFAULT_PLAY_COUNT); setLinks(null); }} />
          <span><b>Preset Vocabulary</b> — {SAMPLE_SET.title} · {SAMPLE_SET.words.length} words</span>
        </label>
        {lists.map((l, i) => (
          <label key={l.key} className="hostclass__opt">
            <input type="radio" name="host-activity" checked={choice === l.key} onChange={() => { setChoice(l.key); setCount(DEFAULT_PLAY_COUNT); setLinks(null); }} />
            <span><b>{l.title}</b> — {l.count} word{l.count === 1 ? "" : "s"}{i === 0 ? " · most recent" : ""}</span>
          </label>
        ))}
        {lists.length === 0 ? <p className="note">Approve a set (1–10 words) in Teacher Studio to add it to your Vocabulary Library and choose it here.</p> : null}
      </fieldset>
      {set ? (
        <>
          <p className="note"><b>{choice === "preset" ? "Preset Vocabulary" : set.title}</b> — {available} available</p>
          <PlayCount available={available} value={playCount} onChange={(n) => { setCount(n); setLinks(null); }} />
        </>
      ) : null}
      <button type="button" className="btn btn--ghost" onClick={create} disabled={busy || !set || access.status === "loading"}>
        {busy ? "Creating…" : "Host for a class (two phones)"}
      </button>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
      {links ? (
        <div className="hostclass__links" role="status">
          <QrCode url={links.primary} />
          <p className="note">Students scan the code (or open the link) on their own phones, then enter a name and a group number. Keep this app running while they play.</p>
          <p className="note">Students can also tap <b>Study Vocabulary</b> on this same class page, before and after their game. It shows exactly these words (not during their rounds).</p>
          {[links.primary, ...links.others].map((u) => (
            <p key={u} className="hostclass__url">
              <a href={u}>{u}</a>
              <button type="button" className="btn btn--small btn--ghost" onClick={() => copy(u)}>{copied === u ? "Copied ✓" : "Copy"}</button>
            </p>
          ))}
        </div>
      ) : (
        <p className="note">{set ? `Creates a link and QR code for “${set.title}” — ${playCount} of ${available} words.` : "Choose an activity above, then create the link."}</p>
      )}
    </div>
  );
}

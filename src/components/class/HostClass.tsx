"use client";

import { useEffect, useState } from "react";
import { SAMPLE_SET, type VocabSet } from "@/data/vocab";
import { todaysWords } from "@/lib/studio/ops";
import { getBrowserStorage, loadActivities } from "@/lib/studio/storage";
import { pickClassroomUrls } from "@/lib/class/url";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { clampPlayCount, DEFAULT_PLAY_COUNT, selectWords } from "@/lib/playCount";
import { PlayCount } from "../PlayCount";
import { QrCode } from "../QrCode";
import { TeacherPasscodeForm } from "../TeacherPasscodeForm";
import { useTeacherAccess } from "../useTeacherAccess";

type Choice = "preset" | "today";

/** Teacher: choose an activity, publish it for a class, and get the link and a QR code students scan with their phones. */
export function HostClass() {
  const access = useTeacherAccess();
  // Today's Words is read from this browser's saved Studio activities (it survives refreshes; re-read on mount and on tab focus).
  const [today, setToday] = useState<VocabSet | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null); // the teacher must choose explicitly
  useEffect(() => {
    const read = () => setToday(todaysWords(loadActivities(getBrowserStorage()).activities));
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  const set = choice === "today" ? today : choice === "preset" ? SAMPLE_SET : null;
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
    try {
      const res = await fetch("/api/class", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...teacherHeaders() },
        body: JSON.stringify({ set: { title: set.title, words: selectWords(set.words, playCount) } }),
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
        <label className={`hostclass__opt ${today ? "" : "is-disabled"}`}>
          <input type="radio" name="host-activity" disabled={!today} checked={choice === "today" && !!today} onChange={() => { setChoice("today"); setCount(DEFAULT_PLAY_COUNT); setLinks(null); }} />
          <span>
            {today ? <><b>Today&apos;s Words</b> — {today.title} · {today.words.length} words</> : <><b>Today&apos;s Words</b> — Not available yet.</>}
          </span>
        </label>
        {!today ? <p className="note">Approve a set (1–10 words) in Teacher Studio to make it available here.</p> : null}
      </fieldset>
      {set ? (
        <>
          <p className="note"><b>{choice === "today" ? "Today's Words" : "Preset Vocabulary"}</b> — {available} available</p>
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

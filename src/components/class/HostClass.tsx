"use client";

import { useState } from "react";
import type { VocabSet } from "@/data/vocab";
import { pickClassroomUrls } from "@/lib/class/url";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { QrCode } from "../QrCode";
import { TeacherPasscodeForm } from "../TeacherPasscodeForm";
import { useTeacherAccess } from "../useTeacherAccess";

/** Teacher: publish the selected set as a class activity; get the link and a QR code students scan with their phones. */
export function HostClass({ set }: { set: VocabSet }) {
  const access = useTeacherAccess();
  const [links, setLinks] = useState<{ primary: string; others: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/class", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...teacherHeaders() },
        body: JSON.stringify({ set: { title: set.title, words: set.words } }),
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
      <button type="button" className="btn btn--ghost" onClick={create} disabled={busy || access.status === "loading"}>
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
        <p className="note">Creates a link and QR code for the selected word set.</p>
      )}
    </div>
  );
}

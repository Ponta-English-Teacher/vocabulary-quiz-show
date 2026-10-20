"use client";

import { useState } from "react";
import type { VocabSet } from "@/data/vocab";

/** Teacher: publish the selected set as a class activity and get the link students open on their phones. */
export function HostClass({ set }: { set: VocabSet }) {
  const [links, setLinks] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/class", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set: { title: set.title, words: set.words } }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error?.message ?? "Could not create the class link.");
      const host = window.location.hostname;
      const local = host === "localhost" || host === "127.0.0.1";
      const own = `${window.location.origin}${j.path}`;
      // On localhost, phones can't use "localhost": offer the laptop's Wi-Fi addresses.
      setLinks(local && j.lanUrls?.length ? j.lanUrls : [own, ...(j.lanUrls ?? []).filter((u: string) => u !== own)]);
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

  return (
    <div className="hostclass">
      <button type="button" className="btn btn--ghost" onClick={create} disabled={busy}>
        {busy ? "Creating…" : "Host for a class (two phones)"}
      </button>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
      {links ? (
        <div className="hostclass__links" role="status">
          <p className="note">Students open this on their own phones (same Wi-Fi), then enter a name and group number. Keep this app running while they play.</p>
          {links.map((u) => (
            <p key={u} className="hostclass__url">
              <a href={u}>{u}</a>
              <button type="button" className="btn btn--small btn--ghost" onClick={() => copy(u)}>{copied === u ? "Copied ✓" : "Copy"}</button>
            </p>
          ))}
        </div>
      ) : (
        <p className="note">Creates a link for the selected word set. Needs the app running on a laptop all students can reach.</p>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { VocabWord } from "@/data/vocab";
import { publishStudy, unpublishStudy } from "@/lib/study/client";
import { addShare, loadShares, removeShare, type StudyShare as Share } from "@/lib/study/shares";
import { getBrowserStorage } from "@/lib/studio/storage";
import { QrCode } from "../QrCode";

/**
 * Teacher: publish a student study page for exactly these words, show its link and QR code, and take it down again.
 * Publishing is always an explicit click, and the page is a snapshot: later edits to the list don't change it until the
 * teacher presses "Update".
 */
export function StudyShareControls({ source, title, words }: { source: string; title: string; words: VocabWord[] }) {
  const [share, setShare] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    setShare(loadShares(getBrowserStorage()).find((s) => s.source === source) ?? null);
  }, [source]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    const old = share;
    const r = await publishStudy(title, words);
    if (!r.ok) {
      setError(r.message);
      setBusy(false);
      return;
    }
    if (old) {
      await unpublishStudy(old.token); // the old link stops working once it has been replaced
      removeShare(getBrowserStorage(), old.token);
    }
    const next: Share = { token: r.token, source, title, words: words.length, url: r.url, createdAt: Date.now(), expiresAt: r.expiresAt };
    addShare(getBrowserStorage(), next);
    setShare(next);
    setBusy(false);
  };

  const stop = async () => {
    if (!share) return;
    setBusy(true);
    setError(null);
    const r = await unpublishStudy(share.token);
    if (!r.ok) {
      setError(r.message ?? "Could not take the page down.");
      setBusy(false);
      return;
    }
    removeShare(getBrowserStorage(), share.token);
    setShare(null);
    setShowQr(false);
    setBusy(false);
  };

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="studyshare">
      {share ? (
        <>
          <p className="note">
            <b>Study page shared</b> — {share.words} word{share.words === 1 ? "" : "s"} · until {new Date(share.expiresAt).toLocaleDateString()}. Anyone who has the link can read it (it shows definitions, Japanese and examples — no hints).
          </p>
          <p className="hostclass__url">
            <a href={share.url}>{share.url}</a>
            <button type="button" className="btn btn--small btn--ghost" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setShowQr((v) => !v)}>{showQr ? "Hide QR" : "QR code"}</button>
            <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={publish} title="Publish the list as it is now; the old link stops working">Update</button>
            <button type="button" className="btn btn--small btn--danger" disabled={busy} onClick={stop}>Stop sharing</button>
          </p>
          {showQr ? <QrCode url={share.url} caption="Scan to study" /> : null}
        </>
      ) : (
        <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={publish}>
          {busy ? "Publishing…" : "Share study page"}
        </button>
      )}
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
    </div>
  );
}

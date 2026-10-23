"use client";

import { useEffect, useState } from "react";
import type { StudyWord } from "@/lib/study/types";
import { StudyList } from "./StudyList";

type State = { kind: "loading" } | { kind: "ready"; title: string; words: StudyWord[] } | { kind: "closed"; message: string };

/** The same session the quiz page keeps on this phone (group + token), read only to tell the server who is asking. */
function readSession(activityId: string): { group: string; token: string } | null {
  try {
    const j = JSON.parse(localStorage.getItem(`vqs.class.${activityId}`) ?? "null") as { group?: string; token?: string } | null;
    return j && typeof j.group === "string" && typeof j.token === "string" ? { group: j.group, token: j.token } : null;
  } catch {
    return null;
  }
}

/** Study Vocabulary for a class, opened from the class link / QR code. No login. Closed while your own game is running. */
export function ClassStudy({ activityId }: { activityId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const back = { href: `/class/${activityId}`, label: "Back to the quiz" };
  useEffect(() => {
    let cancelled = false;
    const s = readSession(activityId);
    const url = `/api/class/${encodeURIComponent(activityId)}/study${s ? `?group=${encodeURIComponent(s.group)}` : ""}`;
    fetch(url, { cache: "no-store", headers: s ? { Authorization: `Bearer ${s.token}` } : {} })
      .then(async (res) => {
        const j = await res.json().catch(() => null);
        if (cancelled) return;
        if (j?.ok) setState({ kind: "ready", title: String(j.title), words: j.words as StudyWord[] });
        else setState({ kind: "closed", message: j?.error?.message ?? "Study Vocabulary isn't available." });
      })
      .catch(() => !cancelled && setState({ kind: "closed", message: "Couldn't load the vocabulary. Check your connection and try again." }));
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  if (state.kind === "ready") return <StudyList title={state.title} words={state.words} back={back} />;
  return (
    <main className="study">
      <p className="note" role="status">{state.kind === "loading" ? "Loading the vocabulary…" : state.message}</p>
      <p><a className="btn btn--link" href={back.href}>‹ {back.label}</a></p>
    </main>
  );
}

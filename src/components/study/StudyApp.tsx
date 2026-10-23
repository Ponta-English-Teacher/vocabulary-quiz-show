"use client";

import { useEffect, useState } from "react";
import type { StudyWord } from "@/lib/study/types";
import { StudyList } from "./StudyList";

type State = { kind: "loading" } | { kind: "ready"; title: string; words: StudyWord[] } | { kind: "gone"; message: string };

/** Student study page: opens from a shared link, needs no login, and shows only the one list that was shared. */
export function StudyApp({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/study/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => null);
        if (cancelled) return;
        if (j?.ok) setState({ kind: "ready", title: String(j.title), words: j.words as StudyWord[] });
        else setState({ kind: "gone", message: j?.error?.message ?? "This study link isn't available." });
      })
      .catch(() => !cancelled && setState({ kind: "gone", message: "Couldn't load the study page. Check your connection and try again." }));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "ready") return <StudyList title={state.title} words={state.words} />;
  return (
    <main className="study">
      <p className="note" role="status">{state.kind === "loading" ? "Loading your study page…" : state.message}</p>
    </main>
  );
}

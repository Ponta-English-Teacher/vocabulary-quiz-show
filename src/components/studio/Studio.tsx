"use client";

import { useCallback, useEffect, useState } from "react";
import type { VocabSet } from "@/data/vocab";
import { fetchAiStatus } from "@/lib/studio/ai/client";
import { activityFromSample, approvedSets, createActivity, toVocabSet } from "@/lib/studio/ops";
import { deleteActivity, duplicateActivity, getBrowserStorage, loadActivities, saveActivity } from "@/lib/studio/storage";
import type { Activity } from "@/lib/studio/types";
import { AiBadge, type AiStatus } from "./shared";
import { StudioHome } from "./StudioHome";
import { Workshop } from "./Workshop";

type View = { kind: "home" } | { kind: "workshop"; activity: Activity; key: number };

export function Studio({ onExit, onPlay }: { onExit: () => void; onPlay: (set: VocabSet) => void }) {
  const [view, setView] = useState<View>({ kind: "home" });
  const [activities, setActivities] = useState<Activity[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [storageOk, setStorageOk] = useState(true);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [ai, setAi] = useState<AiStatus>({ mode: "mock", model: null, forceMock: false });

  const refresh = useCallback(() => {
    const storage = getBrowserStorage();
    setStorageOk(storage !== null);
    const r = loadActivities(storage);
    setActivities(r.activities);
    setSkipped(r.skipped);
  }, []);

  useEffect(() => {
    refresh();
    fetchAiStatus().then((s) => setAi((prev) => ({ ...prev, mode: s.mode, model: s.model })));
  }, [refresh]);

  const open = (activity: Activity) => setView({ kind: "workshop", activity, key: Date.now() });

  const playActivity = (a: Activity) => {
    const first = approvedSets(a)[0];
    if (first) onPlay(toVocabSet(a, first));
  };

  return (
    <main className="studio">
      <header className="studio-top">
        <div>
          <p className="eyebrow eyebrow--left">Production office</p>
          <h1 className="studio-title">Teacher <span>Studio</span></h1>
        </div>
        <div className="studio-top__side">
          <AiBadge ai={ai} onToggleMock={(v) => setAi((p) => ({ ...p, forceMock: v }))} />
          <button type="button" className="btn btn--link" onClick={onExit}>‹ Back to the quiz show</button>
        </div>
      </header>

      {view.kind === "home" ? (
        <StudioHome
          activities={activities}
          skipped={skipped}
          storageOk={storageOk}
          message={message}
          onDismissMessage={() => setMessage(null)}
          onNew={() => open(createActivity())}
          onOpen={open}
          onPlay={playActivity}
          onDuplicate={(a) => {
            const r = duplicateActivity(getBrowserStorage(), a.id);
            setMessage(r.ok ? { kind: "info", text: `Duplicated “${a.title}”.` } : { kind: "error", text: r.error });
            refresh();
          }}
          onDelete={(a) => {
            const r = deleteActivity(getBrowserStorage(), a.id);
            setMessage(r.ok ? { kind: "info", text: `Deleted “${a.title}”.` } : { kind: "error", text: r.error });
            refresh();
          }}
          onCopySample={() => {
            const copy = activityFromSample();
            const r = saveActivity(getBrowserStorage(), copy);
            if (!r.ok) setMessage({ kind: "error", text: r.error });
            refresh();
            open(copy);
          }}
        />
      ) : (
        <Workshop
          key={view.key}
          initial={view.activity}
          ai={ai}
          onBack={() => { refresh(); setView({ kind: "home" }); }}
          onSaved={refresh}
          onPlay={onPlay}
        />
      )}
    </main>
  );
}

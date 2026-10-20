"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SAMPLE_SET, type VocabSet } from "@/data/vocab";
import { Game } from "./Game";
import { Stage } from "./Stage";
import { Studio } from "./studio/Studio";
import { TeacherGate } from "./TeacherGate";
import { approvedSets, toVocabSet } from "@/lib/studio/ops";
import { getBrowserStorage, loadActivities } from "@/lib/studio/storage";

/** Top-level switch between the quiz show and the Teacher Studio. */
export function App() {
  const [screen, setScreen] = useState<"game" | "studio">("game");
  const [saved, setSaved] = useState<VocabSet[]>([]);
  const [extra, setExtra] = useState<VocabSet | null>(null);
  const [selectedId, setSelectedId] = useState(SAMPLE_SET.id);
  const [gameKey, setGameKey] = useState(0);

  const reload = useCallback(() => {
    const { activities } = loadActivities(getBrowserStorage());
    setSaved(activities.flatMap((a) => approvedSets(a).map((s) => toVocabSet(a, s))));
  }, []);

  useEffect(reload, [reload]);

  const options = useMemo(() => {
    const list = [SAMPLE_SET, ...saved];
    if (extra && !list.some((s) => s.id === extra.id)) list.push(extra);
    return list;
  }, [saved, extra]);

  return screen === "studio" ? (
    <Stage tone="studio">
      <TeacherGate onBack={() => { reload(); setGameKey((k) => k + 1); setScreen("game"); }}>
      <Studio
        onExit={() => { reload(); setGameKey((k) => k + 1); setScreen("game"); }}
        onPlay={(set) => {
          setExtra(set);
          setSelectedId(set.id);
          reload();
          setGameKey((k) => k + 1);
          setScreen("game");
        }}
      />
      </TeacherGate>
    </Stage>
  ) : (
    <Game
      key={gameKey}
      sets={options}
      selectedId={options.some((s) => s.id === selectedId) ? selectedId : SAMPLE_SET.id}
      onSelectSet={setSelectedId}
      onOpenStudio={() => setScreen("studio")}
    />
  );
}

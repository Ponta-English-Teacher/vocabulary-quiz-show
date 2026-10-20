"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { VocabSet } from "@/data/vocab";
import { redactForTaker } from "@/lib/game";
import { useGameSounds } from "@/lib/useGameSounds";
import { createLocalTransport } from "@/lib/transport";
import { Board } from "./Board";
import { DemoBar, type ViewRole } from "./DemoBar";
import { Final } from "./Final";
import { GiverRound } from "./GiverRound";
import { Hud } from "./Hud";
import { Reveal } from "./Reveal";
import { RoleSwitch } from "./RoleSwitch";
import { SoundToggle } from "./SoundToggle";
import { Stage } from "./Stage";
import { TakerRound } from "./TakerRound";
import { Welcome } from "./Welcome";

export function Game({
  sets,
  selectedId,
  onSelectSet,
  onOpenStudio,
}: {
  sets: VocabSet[];
  selectedId: string;
  onSelectSet: (id: string) => void;
  onOpenStudio: () => void;
}) {
  const activeSet = sets.find((s) => s.id === selectedId) ?? sets[0];
  // DEMO MODE: a local, in-memory transport. A paired-device transport would slot in here.
  const [transport] = useState(() => createLocalTransport());
  const state = useSyncExternalStore(transport.subscribe, transport.getState, transport.getState);
  const dispatch = transport.dispatch;
  const [view, setView] = useState<ViewRole>("giver");

  useGameSounds(state);

  // Each new word starts on the Giver's screen in demo mode.
  useEffect(() => {
    if (state.phase === "board") setView("giver");
  }, [state.phase]);

  const tone = state.phase === "reveal" && state.lastResult?.outcome === "solved" ? "gold" : state.phase === "final" ? "gold" : "default";
  const inGame = state.phase !== "welcome" && state.phase !== "final";

  return (
    <Stage tone={tone}>
      <SoundToggle />
      <div className="frame">
        {inGame ? <Hud state={state} /> : null}

        {state.phase === "welcome" ? (
          <Welcome
            sets={sets}
            selectedId={activeSet.id}
            onSelectSet={onSelectSet}
            onOpenStudio={onOpenStudio}
            onStart={(names) => dispatch({ type: "START", names, words: activeSet.words })}
          />
        ) : null}
        {state.phase === "switch" ? <RoleSwitch key={state.history.length} state={state} onContinue={() => dispatch({ type: "CONTINUE" })} /> : null}
        {state.phase === "board" ? <Board state={state} onPick={(wordId) => dispatch({ type: "PICK", wordId })} /> : null}
        {state.phase === "round" && view === "giver" ? <GiverRound state={state} dispatch={dispatch} /> : null}
        {state.phase === "round" && view === "taker" ? <TakerRound state={redactForTaker(state)} dispatch={dispatch} /> : null}
        {state.phase === "reveal" ? <Reveal state={state} onNext={() => dispatch({ type: "NEXT" })} /> : null}
        {state.phase === "final" ? <Final state={state} onAgain={() => dispatch({ type: "RESET" })} /> : null}
      </div>

      {state.phase !== "welcome" ? (
        <DemoBar state={state} view={view} onView={setView} onRestart={() => dispatch({ type: "RESET" })} />
      ) : null}
    </Stage>
  );
}

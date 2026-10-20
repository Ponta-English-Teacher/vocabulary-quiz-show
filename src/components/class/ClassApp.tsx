"use client";

import type { GameAction } from "@/lib/game";
import type { ClientAction } from "@/lib/class/types";
import { useGameSounds } from "@/lib/useGameSounds";
import { Board } from "../Board";
import { Final } from "../Final";
import { GiverRound } from "../GiverRound";
import { Hud } from "../Hud";
import { Reveal } from "../Reveal";
import { RoleSwitch } from "../RoleSwitch";
import { SoundToggle } from "../SoundToggle";
import { Stage } from "../Stage";
import { TakerRound } from "../TakerRound";
import { ClassBar } from "./ClassBar";
import { JoinForm, Roles, Waiting } from "./Lobby";
import { useClassSession } from "./useClassSession";

/** The student's phone. Everything it shows comes from the server's role-filtered view. */
export function ClassApp({ activityId }: { activityId: string }) {
  const s = useClassSession(activityId);
  const { view } = s;
  const game = view?.game ?? null;
  useGameSounds(game);

  // The existing screens speak GameAction; translate to what the server accepts.
  const dispatch = (a: GameAction) => {
    const map: Partial<Record<GameAction["type"], ClientAction | undefined>> = {
      REVEAL_HINT: { type: "REVEAL_HINT" },
      SKIP: { type: "SKIP" },
      NEXT: { type: "NEXT" },
      CONTINUE: { type: "CONTINUE" },
      RESET: { type: "PLAY_AGAIN" },
    };
    if (a.type === "PICK") return void s.act({ type: "PICK", wordId: a.wordId });
    if (a.type === "ADJUST_HINTS") return void s.act({ type: "ADJUST_HINTS", delta: a.delta });
    if (a.type === "GUESS") return void s.act({ type: "GUESS", text: a.text });
    if (a.type === "GUESS_JA") return void s.act({ type: "GUESS_JA", text: a.text });
    const c = map[a.type];
    if (c) void s.act(c);
  };

  const tone = game && (game.phase === "final" || (game.phase === "reveal" && game.lastResult?.outcome === "solved")) ? "gold" : "default";

  let body;
  if (s.status === "loading") {
    body = <main className="screen"><p className="tagline" role="status">Connecting…</p></main>;
  } else if (s.status === "invalid") {
    body = (
      <main className="screen">
        <h2 className="screen__title">Link not working</h2>
        <p className="tagline">{s.error ?? "This class link isn't valid or has expired. Ask your teacher for a new one."}</p>
      </main>
    );
  } else if (s.status === "join" || !view) {
    body = <JoinForm title={s.title} error={s.error} busy={s.busy} onJoin={s.join} />;
  } else if (view.stage === "waiting") {
    body = (
      <Waiting view={view} onLeave={() => void s.act({ type: "LEAVE" })} />
    );
  } else if (view.stage === "roles" || !game || !view.role) {
    body = <Roles view={view} act={(a) => void s.act(a)} />;
  } else {
    body = (
      <>
        {game.phase !== "final" ? <Hud state={game} /> : null}
        {game.phase === "switch" ? <RoleSwitch key={game.history.length} state={game} you={view.role} onContinue={() => dispatch({ type: "CONTINUE" })} /> : null}
        {game.phase === "board" ? <Board state={game} canPick={view.role === "giver"} onPick={(wordId) => dispatch({ type: "PICK", wordId })} /> : null}
        {game.phase === "round" && view.role === "giver" ? <GiverRound state={game} dispatch={dispatch} /> : null}
        {game.phase === "round" && view.role === "taker" ? <TakerRound state={game} dispatch={dispatch} /> : null}
        {game.phase === "reveal" ? <Reveal state={game} onNext={() => dispatch({ type: "NEXT" })} /> : null}
        {game.phase === "final" ? <Final state={game} onAgain={() => dispatch({ type: "RESET" })} /> : null}
      </>
    );
  }

  return (
    <Stage tone={tone}>
      <SoundToggle />
      <div className="frame">{body}</div>
      {s.status === "active" && view ? <ClassBar view={view} connection={s.connection} notice={s.error} /> : null}
    </Stage>
  );
}

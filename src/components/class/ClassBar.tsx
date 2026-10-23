"use client";

import { useState } from "react";
import type { ClassView, ClientAction } from "@/lib/class/types";
import type { Connection } from "./useClassSession";

/** The early-finish controls. Both partners must agree; until then the game carries on untouched. */
export function EndGame({ view, act }: { view: ClassView; act: (a: ClientAction) => void }) {
  const [asking, setAsking] = useState(false);
  const partner = view.partner?.name ?? "your partner";
  if (!view.game || view.game.phase === "final") return null;

  if (view.end === "requested-by-partner") {
    return (
      <div className="endgame" role="alertdialog" aria-label="End the game?">
        <p><b>{partner}</b> wants to end the game. Only finished words score; the word in play won&apos;t.</p>
        <div className="endgame__row">
          <button type="button" className="btn btn--small btn--danger" onClick={() => act({ type: "CONFIRM_END" })}>End game</button>
          <button type="button" className="btn btn--small btn--ghost" onClick={() => act({ type: "CANCEL_END" })}>Keep playing</button>
        </div>
      </div>
    );
  }
  if (view.end === "requested-by-you") {
    return (
      <div className="endgame" role="status">
        <p>Waiting for <b>{partner}</b> to agree to end the game…</p>
        <button type="button" className="btn btn--small btn--ghost" onClick={() => act({ type: "CANCEL_END" })}>Cancel request</button>
      </div>
    );
  }
  if (view.end === "declined") {
    return (
      <div className="endgame" role="status">
        <p><b>{partner}</b> wants to keep playing.</p>
        <button type="button" className="btn btn--small btn--ghost" onClick={() => act({ type: "CANCEL_END" })}>OK</button>
      </div>
    );
  }
  if (asking) {
    return (
      <div className="endgame" role="alertdialog" aria-label="End the game?">
        <p>End the game for both of you? <b>{partner}</b> has to agree. Only finished words score.</p>
        <div className="endgame__row">
          <button type="button" className="btn btn--small btn--danger" onClick={() => { setAsking(false); act({ type: "REQUEST_END" }); }}>Ask {partner}</button>
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setAsking(false)}>Keep playing</button>
        </div>
      </div>
    );
  }
  return <button type="button" className="btn btn--small btn--ghost endgame__open" onClick={() => setAsking(true)}>End game</button>;
}

/** Bottom bar in class mode: who is connected, and the End Game option. (Replaces the demo bar — there is no view switching here.) */
export function ClassBar({ view, connection, notice, act }: { view: ClassView; connection: Connection; notice: string | null; act: (a: ClientAction) => void }) {
  return (
    <aside className="classbar" aria-label="Connection status">
      {connection === "reconnecting" ? (
        <p className="classbar__alert" role="alert">Reconnecting… your game is safe.</p>
      ) : notice ? (
        <p className="classbar__alert classbar__alert--note" role="status">{notice}</p>
      ) : null}
      <EndGame view={view} act={act} />
      <div className="classbar__row">
        <span className="classbar__badge">Group {view.group}</span>
        <span className={`chip ${connection === "online" ? "is-on" : "is-off"}`}>
          <i aria-hidden="true" /> {view.you.name}
        </span>
        {view.partner ? (
          <span className={`chip ${view.partner.connected ? "is-on" : "is-off"}`}>
            <i aria-hidden="true" /> {view.partner.name}{view.partner.connected ? "" : " — reconnecting…"}
          </span>
        ) : null}
      </div>
    </aside>
  );
}

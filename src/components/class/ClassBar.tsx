import type { ClassView } from "@/lib/class/types";
import type { Connection } from "./useClassSession";

/** Bottom bar in class mode: who is connected. (Replaces the demo bar — there is no view switching here.) */
export function ClassBar({ view, connection, notice }: { view: ClassView; connection: Connection; notice: string | null }) {
  return (
    <aside className="classbar" aria-label="Connection status">
      {connection === "reconnecting" ? (
        <p className="classbar__alert" role="alert">Reconnecting… your game is safe.</p>
      ) : notice ? (
        <p className="classbar__alert classbar__alert--note" role="status">{notice}</p>
      ) : null}
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

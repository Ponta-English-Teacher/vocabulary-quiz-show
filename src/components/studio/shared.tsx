"use client";

import { useState, type ReactNode } from "react";
import type { AiMode } from "@/lib/studio/ai/types";

export interface AiStatus {
  /** What the server has available. */
  mode: AiMode;
  model: string | null;
  /** Teacher chose to use the free mock even though real AI is available. */
  forceMock: boolean;
}

/** Always-visible label so nobody mistakes demo data for real AI output. */
export function AiBadge({ ai, onToggleMock }: { ai: AiStatus; onToggleMock: (v: boolean) => void }) {
  const live = ai.mode === "openai" && !ai.forceMock;
  return (
    <div className={`aibadge ${live ? "aibadge--live" : "aibadge--mock"}`}>
      <span className="aibadge__dot" aria-hidden="true" />
      <span className="aibadge__text">
        {live ? (
          <>
            <b>Live AI</b> · {ai.model}
          </>
        ) : (
          <>
            <b>Mock AI</b> · demo words only
          </>
        )}
      </span>
      {ai.mode === "openai" ? (
        <button type="button" className="aibadge__switch" onClick={() => onToggleMock(!ai.forceMock)}>
          {ai.forceMock ? "Use live AI" : "Use free mock"}
        </button>
      ) : null}
    </div>
  );
}

export function StorageNotice() {
  return (
    <p className="storage-note" role="note">
      <b>Saved in this browser only.</b> Activities don&apos;t sync to other devices or browsers, and this is not permanent cloud
      storage — clearing site data or using a private window can erase them.
    </p>
  );
}

/** Two-step destructive action, inline (no blocking browser dialogs). */
export function ConfirmButton({
  label,
  confirmText,
  confirmLabel,
  onConfirm,
  className = "btn btn--small btn--ghost",
}: {
  label: string;
  confirmText: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" className={className} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={confirmText}>
      <span className="confirm__text">{confirmText}</span>
      <button type="button" className="btn btn--small btn--danger" onClick={() => { setArmed(false); onConfirm(); }}>
        {confirmLabel}
      </button>
      <button type="button" className="btn btn--small btn--ghost" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

export function Notice({ kind, children, onClose }: { kind: "error" | "info"; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`notice notice--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onClose ? (
        <button type="button" className="notice__x" aria-label="Dismiss" onClick={onClose}>×</button>
      ) : null}
    </div>
  );
}

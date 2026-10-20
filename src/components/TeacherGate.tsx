"use client";

import type { ReactNode } from "react";
import { TeacherPasscodeForm } from "./TeacherPasscodeForm";
import { useTeacherAccess } from "./useTeacherAccess";

/** Wraps the Teacher Studio: students never see it, and it asks for the passcode when the server requires one. */
export function TeacherGate({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  const t = useTeacherAccess();
  if (t.allowed) return <>{children}</>;
  return (
    <main className="screen welcome">
      <p className="eyebrow">Production office</p>
      <h2 className="screen__title">Teacher tools</h2>
      {t.status === "loading" ? <p className="note" role="status">Checking access…</p> : null}
      {t.status === "locked" ? (
        <p className="note" role="alert">Teacher tools are locked because no teacher passcode is configured on this server. Set TEACHER_PASSCODE and redeploy.</p>
      ) : null}
      {t.status === "needs" ? <TeacherPasscodeForm error={t.error} busy={t.busy} onSubmit={t.submit} /> : null}
      <button type="button" className="btn btn--link" onClick={onBack}>‹ Back to the quiz show</button>
    </main>
  );
}

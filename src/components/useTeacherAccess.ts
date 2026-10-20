"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTeacherMode, getPasscode, verifyPasscode } from "@/lib/teacher/client";

export type TeacherStatus = "loading" | "open" | "needs" | "locked" | "ok";

/** Does the server want a teacher passcode, and do we already have it (this tab)? */
export function useTeacherAccess() {
  const [status, setStatus] = useState<TeacherStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTeacherMode().then((m) => {
      if (cancelled) return;
      setStatus(m === "open" ? "open" : m === "locked" ? "locked" : getPasscode() ? "ok" : "needs");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async (passcode: string) => {
    setBusy(true);
    setError(null);
    const r = await verifyPasscode(passcode.trim());
    setBusy(false);
    if (r.ok) setStatus("ok");
    else setError(r.message);
  }, []);

  return { status, error, busy, submit, allowed: status === "open" || status === "ok" };
}

/** Browser helpers for the teacher passcode. The passcode lives in sessionStorage only (cleared when the tab closes). */
const KEY = "vqs.teacher.passcode";

export type TeacherMode = "open" | "passcode" | "locked";

export function getPasscode(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
export function setPasscode(p: string): void {
  try {
    sessionStorage.setItem(KEY, p);
  } catch {
    /* storage blocked: the teacher will be asked again */
  }
}
export function clearPasscode(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function teacherHeaders(): Record<string, string> {
  const p = getPasscode();
  return p ? { "x-teacher-passcode": p } : {};
}

export async function fetchTeacherMode(): Promise<TeacherMode> {
  try {
    const j = (await (await fetch("/api/teacher", { cache: "no-store" })).json()) as { mode?: TeacherMode };
    return j.mode === "passcode" || j.mode === "locked" ? j.mode : "open";
  } catch {
    return "open"; // the server will still enforce whatever it requires
  }
}

export async function verifyPasscode(passcode: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/teacher", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode }) });
    const j = (await res.json()) as { ok?: boolean; error?: { message?: string } };
    if (j.ok) {
      setPasscode(passcode);
      return { ok: true };
    }
    return { ok: false, message: j.error?.message ?? "That passcode didn't work." };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection." };
  }
}

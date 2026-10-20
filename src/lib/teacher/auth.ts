import { createHash, timingSafeEqual } from "node:crypto";
import type { KV } from "@/lib/class/kv";

/**
 * Teacher-only access (Teacher Studio, which spends OpenAI credit, and creating class links).
 *
 *  - TEACHER_PASSCODE set       → every teacher request must carry it (header `x-teacher-passcode`).
 *  - not set, running on Vercel → teacher tools are LOCKED (never publicly open by accident).
 *  - not set, running locally   → open, as on a private laptop.
 *
 * Wrong guesses are counted per client; after MAX_FAILURES within the window further attempts get 429,
 * even for the correct passcode, so the passcode can't be brute-forced.
 */

export const TEACHER_HEADER = "x-teacher-passcode";
export const MAX_FAILURES = 10;
const WINDOW_SECONDS = 10 * 60;

export interface TeacherEnv {
  TEACHER_PASSCODE?: string;
  VERCEL?: string;
}
export type TeacherMode = "open" | "passcode" | "locked";

export function teacherMode(env: TeacherEnv): TeacherMode {
  if (env.TEACHER_PASSCODE) return "passcode";
  return env.VERCEL ? "locked" : "open";
}

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time comparison that doesn't leak length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; status: 401 | 429 | 503; code: "teacher_auth" | "rate_limited" | "not_configured"; message: string };

export async function checkTeacher(provided: string | null, env: TeacherEnv, kv: () => KV, clientId: string): Promise<AuthDecision> {
  const mode = teacherMode(env);
  if (mode === "open") return { ok: true };
  if (mode === "locked") {
    return { ok: false, status: 503, code: "not_configured", message: "Teacher tools are locked: no TEACHER_PASSCODE is configured on the server." };
  }
  const key = `vqs:tauth:${createHash("sha256").update(clientId).digest("hex").slice(0, 24)}`;
  // The failure counter is best-effort: if storage is unavailable the passcode is still enforced.
  try {
    if ((Number(await kv().get(key)) || 0) >= MAX_FAILURES) {
      return { ok: false, status: 429, code: "rate_limited", message: "Too many wrong passcodes. Wait a few minutes and try again." };
    }
  } catch {
    /* ignore */
  }
  if (provided && safeEqual(provided, env.TEACHER_PASSCODE!)) return { ok: true };
  try {
    await kv().incr(key, WINDOW_SECONDS);
  } catch {
    /* ignore */
  }
  return { ok: false, status: 401, code: "teacher_auth", message: provided ? "That teacher passcode isn't right." : "A teacher passcode is required." };
}

export function clientIdOf(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || request.headers.get("x-real-ip") || "unknown";
}

import { kvFromEnv } from "@/lib/class/kv";
import { checkTeacher, clientIdOf, teacherMode, type TeacherEnv } from "@/lib/teacher/auth";

export const dynamic = "force-dynamic";

/** Does this server require a teacher passcode? (Public; reveals nothing secret.) */
export async function GET() {
  return Response.json({ ok: true, mode: teacherMode(process.env as TeacherEnv) }, { headers: { "Cache-Control": "no-store" } });
}

/** Check a passcode so the sign-in screen can say right/wrong. Counts toward the same lockout as every other attempt. */
export async function POST(request: Request) {
  let passcode: string | null = null;
  try {
    const body = JSON.parse(await request.text()) as { passcode?: unknown };
    passcode = typeof body.passcode === "string" ? body.passcode.slice(0, 200) : null;
  } catch {
    /* treated as a missing passcode */
  }
  const d = await checkTeacher(passcode, process.env as TeacherEnv, () => kvFromEnv(process.env as never), clientIdOf(request));
  return d.ok
    ? Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ ok: false, error: { code: d.code, message: d.message } }, { status: d.status, headers: { "Cache-Control": "no-store" } });
}

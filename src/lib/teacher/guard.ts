import { kvFromEnv } from "@/lib/class/kv";
import { checkTeacher, clientIdOf, TEACHER_HEADER, type TeacherEnv } from "./auth";

/** Returns an error Response if the request may not use teacher-only functions, otherwise null. */
export async function requireTeacher(request: Request, env: TeacherEnv = process.env as TeacherEnv): Promise<Response | null> {
  const d = await checkTeacher(request.headers.get(TEACHER_HEADER), env, () => kvFromEnv(process.env as never), clientIdOf(request));
  if (d.ok) return null;
  return Response.json(
    { ok: false, mode: "mock", error: { code: d.code, message: d.message } },
    { status: d.status, headers: { "Cache-Control": "no-store" } },
  );
}

import { errorResponse, lanAddresses, okResponse, readJson } from "@/lib/class/http";
import { getStudyService } from "@/lib/study/service";
import { requireTeacher } from "@/lib/teacher/guard";

export const dynamic = "force-dynamic";

/** Teacher: publish a snapshot of one vocabulary list as a student study page. Protected by the teacher passcode. */
export async function POST(request: Request) {
  const denied = await requireTeacher(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await readJson(request, 300_000);
  } catch {
    return errorResponse("bad_request", "Invalid request.");
  }
  const input = body as { title?: unknown; words?: unknown };
  const r = await getStudyService().publish({ title: input?.title, words: input?.words });
  if (!r.ok) return errorResponse(r.code === "not_found" ? "no_activity" : r.code, r.message);
  const path = `/study/${r.token}`;
  const url = new URL(request.url);
  const lanUrls = lanAddresses().map((ip) => `http://${ip}${url.port ? `:${url.port}` : ""}${path}`);
  return okResponse({ token: r.token, path, lanUrls, expiresAt: r.expiresAt });
}

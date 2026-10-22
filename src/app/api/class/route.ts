import { errorResponse, lanAddresses, okResponse, readJson } from "@/lib/class/http";
import { getClassService } from "@/lib/class/service";
import { requireTeacher } from "@/lib/teacher/guard";

export const dynamic = "force-dynamic";

/** Teacher: publish an approved set as a class activity. Returns the join path(s). Protected by the teacher passcode. */
export async function POST(request: Request) {
  const denied = await requireTeacher(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await readJson(request, 4_300_000);
  } catch {
    return errorResponse("bad_request", "Invalid request.");
  }
  const set = (body as { set?: { title?: unknown; words?: unknown } })?.set;
  const r = await getClassService().createActivity({ title: set?.title, words: set?.words });
  if (!r.ok) return errorResponse(r.code, r.message);
  const path = `/class/${r.activity.id}`;
  const url = new URL(request.url);
  const lanUrls = lanAddresses().map((ip) => `http://${ip}${url.port ? `:${url.port}` : ""}${path}`);
  return okResponse({ id: r.activity.id, path, lanUrls });
}

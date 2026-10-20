import { errorResponse, lanAddresses, okResponse, readJson } from "@/lib/class/http";
import { getClassStore } from "@/lib/class/store";

export const dynamic = "force-dynamic";

/** Teacher: publish an approved set as a class activity. Returns the join path(s). */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readJson(request, 200_000);
  } catch {
    return errorResponse("bad_request", "Invalid request.");
  }
  const set = (body as { set?: { title?: unknown; words?: unknown } })?.set;
  const r = getClassStore().createActivity({ title: set?.title, words: set?.words });
  if (!r.ok) return errorResponse(r.code, r.message);
  const path = `/class/${r.activity.id}`;
  const port = new URL(request.url).port;
  const lanUrls = lanAddresses().map((ip) => `http://${ip}${port ? `:${port}` : ""}${path}`);
  return okResponse({ id: r.activity.id, path, lanUrls });
}

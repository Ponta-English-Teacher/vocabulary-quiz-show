import { bearer, errorResponse, okResponse, readJson } from "@/lib/class/http";
import { getClassService } from "@/lib/class/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // drawing one picture can take a while

/**
 * The Giver asks for an illustration of the word in play (a last-resort hint). Authenticated by the classroom session
 * token only: the seat — and so the Giver role — and the word come from the server's own room state, never from the body.
 */
export async function POST(request: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  let body: { group?: unknown };
  try {
    body = (await readJson(request, 1_000)) as typeof body;
  } catch {
    return errorResponse("bad_request", "Invalid request.");
  }
  const r = await getClassService().requestIllustration({ activityId, group: body?.group, token: bearer(request) });
  if (!r.ok) return errorResponse(r.code, r.message);
  return okResponse({ applied: r.applied, view: r.view });
}

import { bearer, errorResponse, okResponse, readJson } from "@/lib/class/http";
import { getClassService } from "@/lib/class/service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  let body: { group?: unknown; opId?: unknown; action?: unknown };
  try {
    body = (await readJson(request, 4_000)) as typeof body;
  } catch {
    return errorResponse("bad_request", "Invalid request.");
  }
  const r = await getClassService().act({ activityId, group: body?.group, token: bearer(request), opId: body?.opId, action: body?.action });
  if (!r.ok) return errorResponse(r.code, r.message);
  return okResponse({ applied: r.applied, view: r.view });
}

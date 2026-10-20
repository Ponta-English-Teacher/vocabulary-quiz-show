import { bearer, errorResponse, okResponse } from "@/lib/class/http";
import { getClassStore } from "@/lib/class/store";

export const dynamic = "force-dynamic";

/** Poll for the caller's own view. The seat (and so the role) comes from the Bearer token only. */
export async function GET(request: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? parseInt(sinceRaw, 10) : undefined;
  const r = getClassStore().getView({ activityId, group: url.searchParams.get("group"), token: bearer(request), since });
  if (!r.ok) return errorResponse(r.code, r.message);
  return r.unchanged ? okResponse({ unchanged: true, version: r.version }) : okResponse({ view: r.view });
}

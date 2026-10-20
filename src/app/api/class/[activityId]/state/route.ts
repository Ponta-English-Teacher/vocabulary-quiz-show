import { bearer, errorResponse, okResponse } from "@/lib/class/http";
import { getClassService, type PartnerState } from "@/lib/class/service";

export const dynamic = "force-dynamic";

/**
 * Poll for the caller's own view. The seat (and so the role) comes from the Bearer token only.
 * `since` = version the phone has; `pc` = partner connection it last showed (1 / 0 / n for "no partner").
 */
export async function GET(request: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? parseInt(sinceRaw, 10) : undefined;
  const pc = url.searchParams.get("pc");
  const partnerWas: PartnerState | undefined = pc === "1" ? true : pc === "0" ? false : pc === "n" ? null : undefined;
  const r = await getClassService().getView({ activityId, group: url.searchParams.get("group"), token: bearer(request), since, partnerWas });
  if (!r.ok) return errorResponse(r.code, r.message);
  return r.unchanged ? okResponse({ unchanged: true, version: r.version }) : okResponse({ view: r.view });
}

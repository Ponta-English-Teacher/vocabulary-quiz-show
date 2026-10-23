import { bearer, errorResponse } from "@/lib/class/http";
import { getClassService } from "@/lib/class/service";

export const dynamic = "force-dynamic";

/**
 * Study vocabulary for a class: the words of the activity this link belongs to, as study fields only. No teacher login.
 * A joined player (Bearer token + group) is refused while their own game is under way.
 */
export async function GET(request: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  const url = new URL(request.url);
  const r = await getClassService().getStudy({ activityId, group: url.searchParams.get("group"), token: bearer(request) });
  if (!r.ok) return errorResponse(r.code, r.message);
  return Response.json({ ok: true, title: r.title, words: r.words }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" } });
}

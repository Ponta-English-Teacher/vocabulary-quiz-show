import { errorResponse, okResponse } from "@/lib/class/http";
import { getClassService } from "@/lib/class/service";

export const dynamic = "force-dynamic";

/** Public, safe info for the join page: title and size only — never any words. */
export async function GET(_req: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  const info = await getClassService().getActivityInfo(activityId);
  if (info && "ok" in info) return errorResponse(info.code, info.message);
  return info ? okResponse({ ...info }) : errorResponse("no_activity", "This class link isn't valid or has expired.");
}

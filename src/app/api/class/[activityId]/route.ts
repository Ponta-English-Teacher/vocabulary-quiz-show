import { errorResponse, okResponse } from "@/lib/class/http";
import { getClassStore } from "@/lib/class/store";

export const dynamic = "force-dynamic";

/** Public, safe info for the join page: title and size only — never any words. */
export async function GET(_req: Request, ctx: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await ctx.params;
  const info = getClassStore().getActivityInfo(activityId);
  return info ? okResponse({ ...info }) : errorResponse("no_activity", "This class link isn't valid or has expired.");
}

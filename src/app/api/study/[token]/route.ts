import { errorResponse } from "@/lib/class/http";
import { getStudyService } from "@/lib/study/service";
import { requireTeacher } from "@/lib/teacher/guard";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

/** Students: read ONE published list by its unguessable token. Read-only, no login, no listing of anything else. */
export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const r = await getStudyService().get(token);
  if (!r.ok) return errorResponse(r.code === "not_found" ? "no_activity" : r.code, r.message);
  return Response.json({ ok: true, title: r.view.title, words: r.view.words, expiresAt: r.view.expiresAt }, { headers: PRIVATE });
}

/** Teacher: take a study page down before it expires. */
export async function DELETE(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const denied = await requireTeacher(request);
  if (denied) return denied;
  const { token } = await ctx.params;
  const r = await getStudyService().unshare(token);
  if (!r.ok) return errorResponse(r.code === "not_found" ? "no_activity" : r.code, r.message);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

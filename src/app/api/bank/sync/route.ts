import { kvFromEnv } from "@/lib/class/kv";
import { clientIdOf } from "@/lib/teacher/auth";
import { requireTeacher } from "@/lib/teacher/guard";
import { fetchLatestBank, syncConfig } from "@/lib/studio/bankSyncServer";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

const MAX_PER_MINUTE = 6;
const fail = (status: number, code: string, message: string) =>
  Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Teacher: "Sync Latest Bank". Fetches the approved question bank from Classroom Quiz Show on the SERVER (the sync token never reaches
 * the browser) and returns it for the page to check and save. Protected by the teacher passcode, rate limited per client.
 * It makes no AI calls and writes nothing on the server.
 */
export async function POST(request: Request) {
  const denied = await requireTeacher(request);
  if (denied) return denied;

  // Best effort: if shared storage is unavailable the teacher passcode above still protects the route.
  try {
    const key = `vqs:banksync:${createHash("sha256").update(clientIdOf(request)).digest("hex").slice(0, 24)}`;
    if ((await kvFromEnv(process.env as never).incr(key, 60)) > MAX_PER_MINUTE) return fail(429, "rate_limited", "Too many sync requests. Wait a minute and try again.");
  } catch {
    /* ignore */
  }

  let etag: string | undefined;
  try {
    const text = await request.text();
    if (text.length > 2000) return fail(400, "bad_request", "Invalid request.");
    const body = text ? (JSON.parse(text) as { etag?: unknown }) : {};
    if (typeof body.etag === "string") etag = body.etag;
  } catch {
    return fail(400, "bad_request", "Invalid request.");
  }

  const cfg = syncConfig();
  if (!cfg.ok) return fail(503, "sync_not_configured", cfg.message);
  const r = await fetchLatestBank(cfg, etag);
  if (r.kind === "error") return fail(r.status, r.code, r.message);
  if (r.kind === "unchanged") return Response.json({ ok: true, status: "unchanged" }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ ok: true, status: "ok", text: r.text, ...(r.etag ? { etag: r.etag } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

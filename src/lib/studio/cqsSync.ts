import { teacherHeaders, clearPasscode } from "@/lib/teacher/client";

export type SyncRequest =
  | { kind: "unchanged" }
  | { kind: "ok"; text: string; etag?: string }
  | { kind: "error"; message: string };

/** Ask THIS app's server to fetch the latest bank from Classroom Quiz Show. The browser never sees the token or talks to Classroom Quiz Show. */
export async function requestLatestBank(etag?: string, fetchImpl: typeof fetch = fetch): Promise<SyncRequest> {
  try {
    const res = await fetchImpl("/api/bank/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...teacherHeaders() },
      body: JSON.stringify(etag ? { etag } : {}),
    });
    const j = (await res.json()) as { ok?: boolean; status?: string; text?: string; etag?: string; error?: { message?: string } };
    if (res.status === 401) clearPasscode();
    if (!j.ok) return { kind: "error", message: j.error?.message ?? "Sync failed." };
    if (j.status === "unchanged") return { kind: "unchanged" };
    if (j.status === "ok" && typeof j.text === "string") return { kind: "ok", text: j.text, ...(typeof j.etag === "string" ? { etag: j.etag } : {}) };
    return { kind: "error", message: "Sync returned an unexpected answer." };
  } catch {
    return { kind: "error", message: "Could not reach this app's server to sync. Check your connection." };
  }
}

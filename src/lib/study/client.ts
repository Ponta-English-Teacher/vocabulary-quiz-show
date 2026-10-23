import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { pickClassroomUrls } from "@/lib/class/url";
import type { VocabWord } from "@/data/vocab";

export type PublishResult = { ok: true; token: string; url: string; expiresAt: number } | { ok: false; message: string };

/** Teacher: publish a snapshot of `words` as a study page. Only the study fields are stored on the server. */
export async function publishStudy(title: string, words: VocabWord[]): Promise<PublishResult> {
  try {
    const res = await fetch("/api/study", { method: "POST", headers: { "Content-Type": "application/json", ...teacherHeaders() }, body: JSON.stringify({ title, words }) });
    const j = await res.json();
    if (res.status === 401) clearPasscode();
    if (!j.ok) return { ok: false, message: j.error?.message ?? "Could not publish the study page." };
    const urls = pickClassroomUrls({ origin: window.location.origin, hostname: window.location.hostname, path: j.path, lanUrls: j.lanUrls ?? [] });
    return { ok: true, token: j.token, url: urls.primary, expiresAt: j.expiresAt };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

export async function unpublishStudy(token: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`/api/study/${encodeURIComponent(token)}`, { method: "DELETE", headers: teacherHeaders() });
    const j = await res.json().catch(() => ({ ok: false }));
    if (res.status === 401) clearPasscode();
    return j.ok ? { ok: true } : { ok: false, message: j.error?.message ?? "Could not take the page down." };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

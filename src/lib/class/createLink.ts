import type { VocabWord } from "@/data/vocab";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { pickClassroomUrls } from "./url";

export type CreateLinkResult = { ok: true; links: { primary: string; others: string[] } } | { ok: false; message: string };

/**
 * Publish words as a class activity through the existing hosting API (POST /api/class) and return the join link(s).
 * The same endpoint, passcode rules and game engine are used however the words were chosen.
 */
export async function createClassLink(title: string, words: VocabWord[]): Promise<CreateLinkResult> {
  try {
    const res = await fetch("/api/class", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...teacherHeaders() },
      body: JSON.stringify({ set: { title, words } }),
    });
    const j = await res.json();
    if (res.status === 401) clearPasscode();
    if (!j.ok) return { ok: false, message: j.error?.message ?? "Could not create the class link." };
    return { ok: true, links: pickClassroomUrls({ origin: window.location.origin, hostname: window.location.hostname, path: j.path, lanUrls: j.lanUrls ?? [] }) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not create the class link." };
  }
}

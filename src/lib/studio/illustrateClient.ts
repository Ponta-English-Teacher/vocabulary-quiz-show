import type { Illustration, VocabWord } from "@/data/vocab";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { coerceIllustration } from "./validation";

/** Browser → our own /api/studio/illustrate route (the browser never sees the API key). Resolves to a picture or a readable reason. */
export async function requestIllustration(word: VocabWord): Promise<{ ok: true; illustration: Illustration } | { ok: false; message: string }> {
  // The picture itself is never sent back to the server; only the words needed to draw it.
  const { illustration: _ignored, ...plain } = word;
  void _ignored;
  try {
    const res = await fetch("/api/studio/illustrate", { method: "POST", headers: { "Content-Type": "application/json", ...teacherHeaders() }, body: JSON.stringify({ word: plain }) });
    if (res.status === 401) {
      clearPasscode();
      return { ok: false, message: "Unlock the teacher tools on the start screen to draw illustrations." };
    }
    const j = (await res.json()) as { ok?: boolean; illustration?: unknown; error?: { message?: string } };
    const ill = j.ok ? coerceIllustration(j.illustration) : undefined;
    if (ill) return { ok: true, illustration: ill };
    return { ok: false, message: j.error?.message ?? "No picture came back." };
  } catch {
    return { ok: false, message: "Couldn't reach the Studio server." };
  }
}

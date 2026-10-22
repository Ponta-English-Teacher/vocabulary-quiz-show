import type { VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { clearPasscode, teacherHeaders } from "@/lib/teacher/client";
import { parseGeneratedWords } from "../validation";
import type { AiMode, StudioData, StudioRequest, StudioResponse } from "./types";

/** Browser → our own /api/studio route. The browser never sees or sends an API key. */

export class StudioClientError extends Error {}

export async function fetchAiStatus(): Promise<{ mode: AiMode; model: string | null }> {
  try {
    const res = await fetch("/api/studio", { cache: "no-store" });
    const j = (await res.json()) as { mode?: AiMode; model?: string | null };
    return { mode: j.mode === "openai" ? "openai" : "mock", model: j.model ?? null };
  } catch {
    return { mode: "mock", model: null };
  }
}

export interface StudioOk<T extends StudioData["task"]> {
  mode: AiMode;
  data: Extract<StudioData, { task: T }>;
}

type ReqOf<T extends StudioData["task"]> = Extract<StudioRequest, { task: T }>;

export async function callStudio<T extends StudioData["task"]>(
  task: T,
  params: Omit<ReqOf<T>, "task" | "forceMock"> & { forceMock?: boolean },
): Promise<StudioOk<T>> {
  const req = { task, ...params } as unknown as StudioRequest;
  let res: Response;
  try {
    res = await fetch("/api/studio", { method: "POST", headers: { "Content-Type": "application/json", ...teacherHeaders() }, body: JSON.stringify(req) });
  } catch {
    throw new StudioClientError("Couldn't reach the Studio server. Is the app running?");
  }
  let body: StudioResponse;
  try {
    body = (await res.json()) as StudioResponse;
  } catch {
    throw new StudioClientError("The Studio server sent an unreadable response.");
  }
  if (res.status === 401) clearPasscode();
  if (!body.ok) throw new StudioClientError(body.error.message);
  if (body.data.task !== task) throw new StudioClientError("Unexpected response from the Studio server.");

  // Defence in depth: re-validate generated vocabulary in the browser too — with the SAME rule as the server. A word the teacher approved
  // is never thrown away here: if its hints fail the check it is kept (and flagged); if the browser must reject it for any other
  // reason it is reported as failed, with the reason. The server's own `failed` / `flagged` lists are always passed on.
  if (body.data.task === "generate") {
    const exclude = "exclude" in req ? (req.exclude as string[]) : [];
    const approved = "approved" in req ? ((req.approved as string[] | undefined) ?? []) : [];
    const server = body.data;
    const parsed = parseGeneratedWords(server.words, { exclude, keepHintFlaws: true });
    const kept = new Set(parsed.words.map((w) => normalize(w.word)));
    const failed = [...(server.failed ?? [])];
    for (const w of server.words) {
      if (kept.has(normalize(w.word)) || !approved.some((a) => normalize(a) === normalize(w.word))) continue;
      if (!failed.some((f) => normalize(f.word) === normalize(w.word))) {
        failed.push({ word: w.word, reason: parsed.rejected.find((r) => normalize(r.word) === normalize(w.word))?.reason ?? "The item was rejected when it was checked in the browser." });
      }
    }
    const flagged = [...(server.flagged ?? []).filter((f) => kept.has(normalize(f.word)))];
    for (const f of parsed.flawed) if (!flagged.some((x) => normalize(x.word) === normalize(f.word))) flagged.push(f);
    body.data = {
      task: "generate", words: parsed.words as VocabWord[], issues: [...server.issues, ...parsed.issues], requested: server.requested,
      ...(failed.length ? { failed } : {}), ...(flagged.length ? { flagged } : {}),
    };
  }
  return { mode: body.mode, data: body.data as Extract<StudioData, { task: T }> };
}

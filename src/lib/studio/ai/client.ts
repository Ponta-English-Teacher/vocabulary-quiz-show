import type { VocabWord } from "@/data/vocab";
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
    res = await fetch("/api/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  } catch {
    throw new StudioClientError("Couldn't reach the Studio server. Is the app running?");
  }
  let body: StudioResponse;
  try {
    body = (await res.json()) as StudioResponse;
  } catch {
    throw new StudioClientError("The Studio server sent an unreadable response.");
  }
  if (!body.ok) throw new StudioClientError(body.error.message);
  if (body.data.task !== task) throw new StudioClientError("Unexpected response from the Studio server.");

  // Defence in depth: re-validate generated vocabulary in the browser too.
  if (body.data.task === "generate") {
    const exclude = "exclude" in req ? (req.exclude as string[]) : [];
    const parsed = parseGeneratedWords(body.data.words, { exclude });
    body.data = { task: "generate", words: parsed.words as VocabWord[], issues: [...body.data.issues, ...parsed.issues], requested: body.data.requested };
  }
  return { mode: body.mode, data: body.data as Extract<StudioData, { task: T }> };
}

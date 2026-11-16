import { handleStudioRequest, resolveMode } from "@/lib/studio/ai/service";
import { DEFAULT_MODEL } from "@/lib/studio/ai/openai";
import { openAIEnabled, openAIKey } from "@/lib/studio/ai/guard";
import { requireTeacher } from "@/lib/teacher/guard";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 60_000;

/** Which AI is active? Never returns the key — only whether one exists. */
export async function GET() {
  const mode = resolveMode({ apiKey: openAIKey() });
  return Response.json({ mode, model: mode === "openai" ? process.env.OPENAI_MODEL || DEFAULT_MODEL : null, openai: openAIEnabled() ? "enabled" : "disabled" });
}

export async function POST(request: Request) {
  // OpenAI usage costs money: teacher passcode required (see lib/teacher/auth.ts).
  const denied = await requireTeacher(request);
  if (denied) return denied;
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return Response.json({ ok: false, mode: "mock", error: { code: "bad_request", message: "Request too large." } }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, mode: "mock", error: { code: "bad_request", message: "Invalid JSON." } }, { status: 400 });
  }
  const { status, body: result } = await handleStudioRequest(body, {
    apiKey: openAIKey(), // undefined while OpenAI is switched off: the free mock answers, nothing is sent to OpenAI
    model: process.env.OPENAI_MODEL,
    fillJapanese: true,
  });
  return Response.json(result, { status });
}

import { coerceWord } from "@/lib/studio/validation";
import { generateIllustration, IllustrateError } from "@/lib/studio/illustration";
import { requireTeacher } from "@/lib/teacher/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Teacher: draw ONE picture for ONE word (a paid image call, so the teacher passcode is required). */
export async function POST(request: Request) {
  const denied = await requireTeacher(request);
  if (denied) return denied;
  const fail = (code: string, message: string, status: number) => Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail("no_ai", "Pictures need the OpenAI key, which isn't set on this server. The activity is still playable without pictures.", 503);
  const text = await request.text();
  if (text.length > 20_000) return fail("bad_request", "Request too large.", 413);
  let word;
  try {
    const c = coerceWord((JSON.parse(text) as { word?: unknown })?.word);
    if (!("word" in c)) return fail("bad_request", "That word is incomplete.", 400);
    word = c.word;
  } catch {
    return fail("bad_request", "Invalid request.", 400);
  }
  try {
    const illustration = await generateIllustration({ apiKey, model: process.env.OPENAI_IMAGE_MODEL }, word);
    return Response.json({ ok: true, illustration }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof IllustrateError) return fail(e.code, e.message, e.code === "timeout" ? 504 : 502);
    return fail("upstream", "Unexpected error while drawing the picture.", 502);
  }
}

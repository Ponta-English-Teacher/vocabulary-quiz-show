import type { Illustration, VocabWord } from "@/data/vocab";
import type { FetchLike } from "./ai/openai";
import { isIllustrationSrc } from "./validation";

/**
 * One AI-drawn picture per word, made in Teacher Studio (never during play). Server-side only: the key is read by the
 * route from process.env. Cost control: one image per request, low quality, small file; the teacher presses the button.
 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-1-mini";

export type IllustrateFailure = "no_ai" | "refused" | "upstream" | "timeout" | "too_large" | "malformed";
export class IllustrateError extends Error {
  constructor(public code: IllustrateFailure, message: string) {
    super(message);
  }
}

type DrawWord = Pick<VocabWord, "word" | "partOfSpeech" | "meaning" | "example" | "category"> & { giverInfo?: VocabWord["giverInfo"] };

/** Concrete things and actions are drawn directly; abstract words (feelings, ideas, expressions) get a simple everyday scene. */
export function illustrationPrompt(w: DrawWord): string {
  const concrete = w.partOfSpeech === "noun" || w.partOfSpeech === "verb";
  const subject = concrete
    ? `Draw the meaning of this English vocabulary item so a learner who has never seen it can understand it: "${w.word}" (${w.partOfSpeech}) — ${w.meaning}`
    : `Draw ONE simple everyday scene that shows the idea of this English vocabulary item without words: "${w.word}" (${w.partOfSpeech}) — ${w.meaning} Show people and a situation where it is clearly true.`;
  const looks = w.giverInfo?.looks ? ` Visual detail: ${w.giverInfo.looks}` : "";
  return [
    subject + looks,
    `Example of use: ${w.example}`,
    "Style: clean, friendly, flat educational illustration; one clear subject; plain light background; bright, clear colours; easy to recognise at a glance on a phone.",
    "STRICT: no text of any kind — no letters, words, numbers, labels, captions, signs, logos or speech bubbles.",
  ].join("\n");
}

export interface IllustrateConfig {
  apiKey: string;
  model?: string;
  /** Test hook (server env only): a stand-in for the OpenAI images endpoint. Defaults to OpenAI. */
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function generateIllustration(cfg: IllustrateConfig, w: DrawWord): Promise<Illustration> {
  const doFetch: FetchLike = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await doFetch(cfg.url || "https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model || DEFAULT_IMAGE_MODEL,
        prompt: illustrationPrompt(w),
        n: 1,
        size: "1024x1024",
        quality: "low",
        output_format: "jpeg",
        output_compression: 60,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 90_000),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new IllustrateError("timeout", "The picture took too long to draw. Try again.");
    }
    throw new IllustrateError("upstream", "Could not reach the picture service.");
  }
  if (res.status === 400) throw new IllustrateError("refused", "The AI would not draw this one. Try again, or play without a picture.");
  if (!res.ok) throw new IllustrateError("upstream", `The picture service returned an error (HTTP ${res.status}). Check the server's API key and image model settings.`);
  let b64: unknown;
  try {
    b64 = ((await res.json()) as { data?: { b64_json?: unknown }[] })?.data?.[0]?.b64_json;
  } catch {
    throw new IllustrateError("malformed", "The picture service sent an unreadable response.");
  }
  if (typeof b64 !== "string" || !b64) throw new IllustrateError("malformed", "The picture service sent no picture.");
  const src = `data:image/jpeg;base64,${b64}`;
  if (!isIllustrationSrc(src)) throw new IllustrateError("too_large", "The picture came back too large to store. Try again.");
  return { src, alt: `Picture illustrating the word (for the Giver): ${w.meaning}`.slice(0, 200) };
}

import { normalize } from "@/lib/answer";
import { coerceJa } from "../validation";
import { callOpenAIJson, type FetchLike } from "./openai";
import { japanesePrompt } from "./prompts";

export interface TranslateCfg { apiKey: string; model: string; fetchImpl?: FetchLike }
export interface WordToTranslate { word: string; partOfSpeech: string; meaning: string }

/** The most words one translation request carries (keeps each request small and cheap). */
export const MAX_TRANSLATE_WORDS = 30;

/**
 * ONE request: Japanese equivalents for these words, keyed by `normalize(word)`. Words the model gives nothing usable for are
 * simply absent from the result. Throws on network/format trouble so callers decide what a failure means for them.
 */
export async function translateJapanese(cfg: TranslateCfg, words: WordToTranslate[]): Promise<Record<string, string[]>> {
  const batch = words.slice(0, MAX_TRANSLATE_WORDS);
  if (!batch.length) return {};
  const raw = (await callOpenAIJson(cfg, japanesePrompt(batch))) as { ja?: Record<string, unknown> };
  const table = raw && typeof raw.ja === "object" && raw.ja ? raw.ja : {};
  const byWord = new Map(Object.entries(table).map(([k, v]) => [normalize(k), v]));
  const out: Record<string, string[]> = {};
  for (const w of batch) {
    const list = coerceJa(byWord.get(normalize(w.word)));
    if (list.length) out[normalize(w.word)] = list;
  }
  return out;
}

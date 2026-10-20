import { AiError } from "./types";

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Server-side only. Calls the OpenAI Chat Completions API and returns the parsed JSON object
 * from the model. The API key is read by the route from process.env and never leaves the server;
 * error messages deliberately never include upstream response bodies.
 */
export async function callOpenAIJson(cfg: OpenAIConfig, messages: ChatMsg[]): Promise<unknown> {
  const doFetch: FetchLike = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await doFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 45_000),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AiError("timeout", "The AI took too long to answer. Please try again.");
    }
    throw new AiError("upstream", "Could not reach the AI service.");
  }
  if (!res.ok) {
    throw new AiError("upstream", `The AI service returned an error (HTTP ${res.status}). Check the server's API key and model settings.`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AiError("malformed", "The AI service sent an unreadable response.");
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new AiError("malformed", "The AI response had no content.");
  try {
    return JSON.parse(content);
  } catch {
    throw new AiError("malformed", "The AI did not return valid JSON.");
  }
}

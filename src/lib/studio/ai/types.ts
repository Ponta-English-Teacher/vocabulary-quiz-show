import type { VocabWord } from "@/data/vocab";
import type { Brief, ChatMessage, ChatResult, SetContext } from "../types";

/** Wire format between the browser and /api/studio. No secrets ever cross it. */
interface Common {
  brief: Brief;
  /** Mock AI is always free to use, even when a real key is configured. */
  forceMock?: boolean;
}

export type StudioRequest =
  | (Common & { task: "chat"; messages: ChatMessage[]; context?: SetContext })
  | (Common & { task: "generate"; count: number; exclude: string[]; /** Teacher-approved words to use exactly, unchanged. */ approved?: string[]; instruction?: string })
  | (Common & { task: "replace-word"; current: VocabWord; exclude: string[]; instruction?: string })
  | (Common & { task: "regenerate-hints"; word: VocabWord; instruction?: string });

export type AiMode = "openai" | "mock";

export type StudioData =
  | { task: "chat"; result: ChatResult }
  | {
      task: "generate"; words: VocabWord[]; issues: string[]; requested: number;
      /** Teacher-approved words that could NOT be written, each with the reason. Never silently dropped. */
      failed?: { word: string; reason: string }[];
      /** Teacher-approved words whose item exists but whose HINTS still need correction (the word is kept, never dropped). */
      flagged?: { word: string; reason: string; hints: number[] }[];
    }
  | { task: "replace-word"; word: VocabWord }
  | { task: "regenerate-hints"; hints: [string, string, string] };

export type AiErrorCode = "bad_request" | "malformed" | "upstream" | "timeout" | "unsupported" | "validation";

export type StudioResponse =
  | { ok: true; mode: AiMode; model?: string; data: StudioData }
  | { ok: false; mode: AiMode; error: { code: AiErrorCode; message: string } };

export class AiError extends Error {
  constructor(public code: AiErrorCode, message: string) {
    super(message);
  }
}

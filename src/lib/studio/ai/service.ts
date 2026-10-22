import type { VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { parseGeneratedWords } from "../validation";
import { mockApproved, mockChat, mockGenerate, mockHints, mockReplace } from "./mock";
import { callOpenAIJson, DEFAULT_MODEL, type FetchLike } from "./openai";
import { mergeAiCandidates } from "../candidates";
import type { Brief, ChatResult } from "../types";
import { enforceApproval, enforceMixture, parseChatResult, parseHints, parseStudioRequest } from "./parse";
import { approvedPrompt, chatPrompt, generatePrompt, hintsPrompt, replacePrompt } from "./prompts";
import { AiError, type AiMode, type StudioData, type StudioRequest, type StudioResponse } from "./types";

/** At most this many calls to fill ONE set (cost cap), asking a few extra items each time. */
export const MAX_GENERATE_ATTEMPTS = 3;
const EXTRA_ITEMS = 3;
const MAX_ASK = 14;

export interface ServiceDeps {
  /** From process.env on the server. Absent → mock mode. */
  apiKey?: string;
  model?: string;
  fetchImpl?: FetchLike;
  rng?: () => number;
}

export function resolveMode(deps: ServiceDeps, forceMock = false): AiMode {
  return deps.apiKey && !forceMock ? "openai" : "mock";
}

export function statusFor(code: string): number {
  switch (code) {
    case "bad_request": return 400;
    case "unsupported": return 422;
    case "validation": return 502;
    case "malformed": return 502;
    case "timeout": return 504;
    default: return 502;
  }
}

/** Single entry point used by the route handler (and by tests with a fake fetch). */
export async function handleStudioRequest(body: unknown, deps: ServiceDeps): Promise<{ status: number; body: StudioResponse }> {
  let mode: AiMode = deps.apiKey ? "openai" : "mock";
  try {
    const req = parseStudioRequest(body);
    mode = resolveMode(deps, req.forceMock);
    const data = mode === "mock" ? runMock(req, deps) : await runOpenAI(req, deps);
    return { status: 200, body: { ok: true, mode, model: mode === "openai" ? deps.model || DEFAULT_MODEL : undefined, data } };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("upstream", "Unexpected error while talking to the AI.");
    return { status: statusFor(e.code), body: { ok: false, mode, error: { code: e.code, message: e.message } } };
  }
}

/** The AI's candidate list is combined with the teacher's hand edits BEFORE approval is checked, so "go ahead" uses the teacher's exact list. */
function keepTeacherWords(result: ChatResult, prev: Brief): ChatResult {
  return { ...result, brief: mergeAiCandidates(prev, result.brief) };
}

function runMock(req: StudioRequest, deps: ServiceDeps): StudioData {
  const rng = deps.rng ?? Math.random;
  switch (req.task) {
    case "chat":
      {
      const last = req.messages[req.messages.length - 1].text;
      return { task: "chat", result: enforceMixture(enforceApproval(keepTeacherWords(mockChat(req.messages, req.brief, req.context), req.brief), req.brief, last), last) };
    }
    case "generate": {
      const approved = (req.approved ?? []).slice(0, req.count);
      const fromList = approved.length ? mockApproved(approved) : { words: [], issues: [] as string[] };
      const extra = approved.length ? req.count - approved.length : req.count;
      const taken = [...req.exclude, ...approved, ...fromList.words.map((w) => w.word)];
      const more = extra > 0 ? mockGenerate(req.brief, extra, taken, rng) : [];
      const words = [...fromList.words, ...more];
      const issues = [...fromList.issues];
      if (words.length < req.count) issues.push(`Mock AI only had ${words.length} demo words for this request.`);
      if (words.length === 0) throw new AiError("unsupported", issues.join(" ") || "Mock AI has no demo words for this.");
      return { task: "generate", words, requested: req.count, issues };
    }
    case "replace-word":
      return { task: "replace-word", word: mockReplace(req.brief, req.current, req.exclude, rng) };
    case "regenerate-hints":
      return { task: "regenerate-hints", hints: mockHints(req.word) };
  }
}

async function runOpenAI(req: StudioRequest, deps: ServiceDeps): Promise<StudioData> {
  const cfg = { apiKey: deps.apiKey!, model: deps.model || DEFAULT_MODEL, fetchImpl: deps.fetchImpl };

  switch (req.task) {
    case "chat": {
      const raw = await callOpenAIJson(cfg, chatPrompt(req.messages, req.brief, req.context));
      const last = req.messages[req.messages.length - 1].text;
      return { task: "chat", result: enforceMixture(enforceApproval(keepTeacherWords(parseChatResult(raw, req.brief), req.brief), req.brief, last), last) };
    }

    case "generate": {
      const issues: string[] = [];
      const required = uniqueWords(req.approved ?? []).slice(0, req.count);
      const found: VocabWord[] = [];

      // 1) Teacher-approved words: write items for EXACTLY these words (unchanged), retrying only what is missing.
      if (required.length > 0) {
        let feedback: string[] = [];
        for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
          const missing = required.filter((w) => !found.some((f) => normalize(f.word) === normalize(w)));
          if (missing.length === 0) break;
          let raw: unknown;
          try {
            raw = await callOpenAIJson(cfg, approvedPrompt(req.brief, missing, req.instruction, feedback));
          } catch (e) {
            if (found.length > 0 && e instanceof AiError) {
              issues.push(`A follow-up request failed (${e.message}).`);
              break;
            }
            throw e;
          }
          const parsed = parseGeneratedWords((raw as { words?: unknown })?.words, { exclude: found.map((w) => w.word) });
          issues.push(...parsed.issues);
          for (const w of parsed.words) {
            const target = missing.find((m) => normalize(m) === normalize(w.word));
            if (target && !found.some((f) => normalize(f.word) === normalize(target))) found.push({ ...w, word: target });
            else issues.push(`“${w.word}” is not one of the approved words, so it was dropped.`);
          }
          feedback = [...parsed.issues, ...(parsed.words.length === 0 ? ["Return one item for each approved word, spelled exactly as listed."] : [])].slice(0, 6);
        }
        found.sort((a, b) => required.findIndex((r) => normalize(r) === normalize(a.word)) - required.findIndex((r) => normalize(r) === normalize(b.word)));
        const stillMissing = required.filter((w) => !found.some((f) => normalize(f.word) === normalize(w)));
        if (stillMissing.length) issues.push(`Could not write valid items for approved word${stillMissing.length === 1 ? "" : "s"}: ${stillMissing.join(", ")}.`);
      }

      // 2) Anything beyond the approved list (or the whole set when nothing was approved) is generated freely.
      const extrasWanted = required.length ? req.count - required.length : req.count;
      if (extrasWanted > 0) {
        const free = await generateFree(cfg, req, extrasWanted, [...req.exclude, ...required, ...found.map((w) => w.word)], found.length > 0);
        found.push(...free.words);
        issues.push(...free.issues);
      }
      if (found.length === 0) throw new AiError("malformed", "The AI did not return any usable vocabulary. Nothing was changed.");
      return { task: "generate", words: found, issues, requested: req.count };
    }

    case "replace-word": {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await callOpenAIJson(cfg, replacePrompt(req.brief, req.current, req.exclude, req.instruction));
        const exclude = [...req.exclude, req.current.word];
        const parsed = parseGeneratedWords([(raw as { word?: unknown })?.word], { exclude, max: 1, topic: req.brief.topic, wordType: req.brief.wordType });
        if (parsed.words[0]) return { task: "replace-word", word: parsed.words[0] };
      }
      throw new AiError("malformed", "The AI could not produce a valid replacement. The original word was kept.");
    }

    case "regenerate-hints": {
      let last: AiError | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await callOpenAIJson(cfg, hintsPrompt(req.brief, req.word, req.instruction));
          return { task: "regenerate-hints", hints: parseHints(raw, req.word) };
        } catch (e) {
          if (!(e instanceof AiError) || (e.code !== "validation" && e.code !== "malformed")) throw e;
          last = e;
        }
      }
      throw last ?? new AiError("malformed", "Could not produce valid hints.");
    }
  }
}

function uniqueWords(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map((w) => w.trim()).filter((w) => w && !seen.has(normalize(w)) && seen.add(normalize(w)));
}

/**
 * Free generation of exactly `count` valid, distinct words: each round asks for a few EXTRA items
 * (to absorb rejects), tells the model what was wrong last time, and only needs the shortfall.
 */
async function generateFree(
  cfg: { apiKey: string; model: string; fetchImpl?: FetchLike },
  req: Extract<StudioRequest, { task: "generate" }>,
  count: number,
  baseExclude: string[],
  haveOthers: boolean,
): Promise<{ words: VocabWord[]; issues: string[] }> {
  const issues: string[] = [];
  const words: VocabWord[] = [];
  let feedback: string[] = [];
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS && words.length < count; attempt++) {
    const need = count - words.length;
    const ask = Math.min(need + EXTRA_ITEMS, MAX_ASK);
    const exclude = [...baseExclude, ...words.map((w) => w.word)];
    let raw: unknown;
    try {
      raw = await callOpenAIJson(cfg, generatePrompt(req.brief, ask, exclude, req.instruction, feedback, need));
    } catch (e) {
      if ((words.length > 0 || haveOthers) && e instanceof AiError) {
        issues.push(`A follow-up request failed (${e.message}).`);
        break;
      }
      throw e;
    }
    const parsed = parseGeneratedWords((raw as { words?: unknown })?.words, { exclude, max: need, topic: req.brief.topic, wordType: req.brief.wordType });
    words.push(...parsed.words);
    issues.push(...parsed.issues);
    feedback = parsed.issues.slice(0, 6);
  }
  return { words, issues };
}

export { normalize };

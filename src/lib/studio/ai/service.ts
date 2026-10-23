import type { VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { hintProblems, parseGeneratedWords } from "../validation";
import { restrictionsFor, withRestrictionNote } from "../restrictions";
import { mockApproved, mockChat, mockGenerate, mockHints, mockReplace } from "./mock";
import { callOpenAIJson, DEFAULT_MODEL, type FetchLike } from "./openai";
import { mergeAiCandidates } from "../candidates";
import type { Brief, ChatResult } from "../types";
import { APPROVAL_RE, DISCUSS_FIRST_RE, enforceApproval, enforceMixture, parseChatResult, parseHints, parseStudioRequest } from "./parse";
import { approvedPrompt, chatPrompt, generatePrompt, hintsPrompt, replacePrompt } from "./prompts";
import { AiError, type AiMode, type StudioData, type StudioRequest, type StudioResponse } from "./types";

/** At most this many calls to fill ONE set (cost cap), asking a few extra items each time. */
export const MAX_GENERATE_ATTEMPTS = 3;
const EXTRA_ITEMS = 3;
const MAX_ASK = 14;
/** Tries to rewrite just the hints of ONE flawed approved word (each is a small request). */
export const HINT_REPAIRS = 2;

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
    // The teacher's checkable hint restrictions go into the brief by code, not by the model's goodwill: the model often forgets them.
    if (req.task === "chat" && data.task === "chat") {
      const last = req.messages[req.messages.length - 1].text;
      data.result.brief.learnerFocus = withRestrictionNote(data.result.brief.learnerFocus, req.brief.learnerFocus, last);
    }
    return { status: 200, body: { ok: true, mode, model: mode === "openai" ? deps.model || DEFAULT_MODEL : undefined, data } };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("upstream", "Unexpected error while talking to the AI.");
    return { status: statusFor(e.code), body: { ok: false, mode, error: { code: e.code, message: e.message } } };
  }
}

/** The AI's candidate list is combined with the teacher's hand edits BEFORE approval is checked, so "go ahead" uses the teacher's exact list. */
function keepTeacherWords(result: ChatResult, prev: Brief, lastTeacherText = ""): ChatResult {
  const merged = mergeAiCandidates(prev, result.brief);
  // A plain "go ahead" must approve the list the teacher was shown. If the model's list came back shorter without the
  // teacher asking for any change, that is the model's slip, not the teacher's decision: keep the shown list.
  const plainApproval = prev.candidates.length > 0 && APPROVAL_RE.test(lastTeacherText) && !DISCUSS_FIRST_RE.test(lastTeacherText) && !CHANGE_RE.test(lastTeacherText);
  if (plainApproval && merged.candidates.length < prev.candidates.length) {
    return { ...result, brief: { ...merged, candidates: prev.candidates, candidateBands: prev.candidateBands, pinnedCandidates: prev.pinnedCandidates, removedCandidates: prev.removedCandidates } };
  }
  return { ...result, brief: merged };
}

/** The teacher is asking to change the list, so a different list from the model is expected. */
const CHANGE_RE = /\b(remove|drop|delete|swap|replace|instead|without|exclude|cut|take out|get rid|fewer|add|include|also)\b/i;

function runMock(req: StudioRequest, deps: ServiceDeps): StudioData {
  const rng = deps.rng ?? Math.random;
  switch (req.task) {
    case "chat":
      {
      const last = req.messages[req.messages.length - 1].text;
      return { task: "chat", result: enforceMixture(enforceApproval(keepTeacherWords(mockChat(req.messages, req.brief, req.context), req.brief, last), req.brief, last), last) };
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
      const failed = approved.filter((w) => !fromList.words.some((f) => normalize(f.word) === normalize(w))).map((w) => ({ word: w, reason: "Mock AI has no demo entry for this word (real AI can write any word)." }));
      return { task: "generate", words, requested: req.count, issues, ...(failed.length ? { failed } : {}) };
    }
    case "replace-word":
      return { task: "replace-word", word: mockReplace(req.brief, req.current, req.exclude, rng) };
    case "regenerate-hints":
      return { task: "regenerate-hints", hints: mockHints(req.word) };
  }
}

async function runOpenAI(req: StudioRequest, deps: ServiceDeps): Promise<StudioData> {
  const cfg = { apiKey: deps.apiKey!, model: deps.model || DEFAULT_MODEL, fetchImpl: deps.fetchImpl };
  // The teacher's checkable hint restrictions (brief notes, then this request's instruction as the newest word).
  const restrictions = req.task === "chat" ? [] : restrictionsFor(req.brief.learnerFocus, req.instruction);

  switch (req.task) {
    case "chat": {
      const raw = await callOpenAIJson(cfg, chatPrompt(req.messages, req.brief, req.context));
      const last = req.messages[req.messages.length - 1].text;
      return { task: "chat", result: enforceMixture(enforceApproval(keepTeacherWords(parseChatResult(raw, req.brief), req.brief, last), req.brief, last), last) };
    }

    case "generate": {
      const issues: string[] = [];
      const required = uniqueWords(req.approved ?? []).slice(0, req.count);
      const found: VocabWord[] = [];
      let failed: { word: string; reason: string }[] = [];
      let flagged: { word: string; reason: string; hints: number[] }[] = [];
      const flawedNow = new Map<string, { reason: string; hints: number[] }>(); // approved word → what is wrong with its hints
      const reasons = new Map<string, string>(); // approved word → why it was rejected last time

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
          const parsed = parseGeneratedWords((raw as { words?: unknown })?.words, { exclude: found.map((w) => w.word), keepHintFlaws: true, restrictions });
          for (const f of parsed.flawed) flawedNow.set(normalize(f.word), { reason: f.reason, hints: f.hints });
          issues.push(...parsed.issues);
          for (const r of parsed.rejected) if (missing.some((m) => normalize(m) === normalize(r.word))) reasons.set(normalize(r.word), r.reason);
          for (const w of parsed.words) {
            const target = missing.find((m) => normalize(m) === normalize(w.word));
            if (target && !found.some((f) => normalize(f.word) === normalize(target))) found.push({ ...w, word: target });
            else issues.push(`“${w.word}” is not one of the approved words, so it was dropped.`);
          }
          feedback = [...parsed.issues, ...(parsed.words.length === 0 ? ["Return one item for each approved word, spelled exactly as listed."] : [])].slice(0, 6);
        }
        // 1b) A word whose HINTS failed validation keeps its item. Only its hints are rewritten (a small request for that one word,
        //     at most HINT_REPAIRS tries each) — the rest of the item, and every other word, is left alone.
        for (const w of found) {
          const flaw = flawedNow.get(normalize(w.word));
          if (!flaw) continue;
          let tried = flaw.reason; // what the next rewrite is told to avoid
          // A hint that only breaks a teacher restriction is rewritten ALONE: the other hints are kept exactly as they are.
          const now = hintProblems(w, restrictions);
          const only = now.length > 0 && now.every((p) => p.code === "restriction") ? [...new Set(now.map((p) => p.hintIndex!))] : null;
          for (let t = 0; t < HINT_REPAIRS; t++) {
            try {
              const ask = only
                ? `${req.instruction ? `${req.instruction}\n` : ""}Only ${only.length === 1 ? `hint ${only[0] + 1}` : `hints ${only.map((i) => i + 1).join(" and ")}`} must change. These hints are fine and will be kept, so make the new one fit with them: ${JSON.stringify(w.hints.filter((_, i) => !only.includes(i)))}. Problem: ${tried} Write three hints in which ${only.length === 1 ? "that hint avoids" : "those hints avoid"} the problem, and no hint contains the word "${w.word}" or any part of it.`
                : `${req.instruction ? `${req.instruction}\n` : ""}Your previous hints were rejected: ${tried} Write three different hints that avoid these problems. The opening hint must be a real situation (who, when, where), and no hint may contain the word "${w.word}" or any part of it.`;
              const raw = await callOpenAIJson(cfg, hintsPrompt(req.brief, w, ask));
              const fresh = parseHints(raw, w);
              const hints = only ? w.hints.map((h, i) => (only.includes(i) ? fresh[i] : h)) : fresh;
              const bad = hintProblems({ ...w, hints }, restrictions);
              if (bad.length) { tried = bad.map((p) => p.message).join(" "); continue; }
              w.hints = hints;
              flawedNow.delete(normalize(w.word));
              break;
            } catch (e) {
              if (!(e instanceof AiError) || (e.code !== "validation" && e.code !== "malformed")) break; // network/key trouble: stop, keep the word
              tried = e.message;
            }
          }
          // Still flawed: the word stays, described by what is actually wrong with the hints it has now.
          if (flawedNow.has(normalize(w.word))) flawedNow.set(normalize(w.word), { reason: `${flaw.reason} Rewriting the hints automatically did not fix it.`, hints: flaw.hints });
        }
        flagged = [...flawedNow].map(([k, f]) => ({ word: found.find((w) => normalize(w.word) === k)!.word, ...f }));
        found.sort((a, b) => required.findIndex((r) => normalize(r) === normalize(a.word)) - required.findIndex((r) => normalize(r) === normalize(b.word)));
        const stillMissing = required.filter((w) => !found.some((f) => normalize(f.word) === normalize(w)));
        if (stillMissing.length) issues.push(`Could not write valid items for approved word${stillMissing.length === 1 ? "" : "s"}: ${stillMissing.join(", ")}.`);
        failed = stillMissing.map((w) => ({ word: w, reason: reasons.get(normalize(w)) ?? "The AI did not return an item for this word." }));
      }

      // 2) Anything beyond the approved list (or the whole set when nothing was approved) is generated freely.
      const extrasWanted = required.length ? req.count - required.length : req.count;
      if (extrasWanted > 0) {
        const free = await generateFree(cfg, req, extrasWanted, [...req.exclude, ...required, ...found.map((w) => w.word)], found.length > 0);
        found.push(...free.words);
        issues.push(...free.issues);
      }
      if (found.length === 0) throw new AiError("malformed", "The AI did not return any usable vocabulary. Nothing was changed.");
      return { task: "generate", words: found, issues, requested: req.count, ...(failed.length ? { failed } : {}), ...(flagged.length ? { flagged } : {}) };
    }

    case "replace-word": {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await callOpenAIJson(cfg, replacePrompt(req.brief, req.current, req.exclude, req.instruction));
        const exclude = [...req.exclude, req.current.word];
        const parsed = parseGeneratedWords([(raw as { word?: unknown })?.word], { exclude, max: 1, topic: req.brief.topic, wordType: req.brief.wordType, restrictions });
        if (parsed.words[0]) return { task: "replace-word", word: parsed.words[0] };
      }
      throw new AiError("malformed", "The AI could not produce a valid replacement. The original word was kept.");
    }

    case "regenerate-hints": {
      let last: AiError | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await callOpenAIJson(cfg, hintsPrompt(req.brief, req.word, req.instruction));
          const hints = parseHints(raw, req.word);
          const bad = hintProblems({ ...req.word, hints }, restrictions);
          if (bad.length) throw new AiError("validation", bad.map((p) => p.message).join(" "));
          return { task: "regenerate-hints", hints };
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
    const parsed = parseGeneratedWords((raw as { words?: unknown })?.words, { exclude, max: need, topic: req.brief.topic, wordType: req.brief.wordType, restrictions: restrictionsFor(req.brief.learnerFocus, req.instruction) });
    words.push(...parsed.words);
    issues.push(...parsed.issues);
    feedback = parsed.issues.slice(0, 6);
  }
  return { words, issues };
}

export { normalize };

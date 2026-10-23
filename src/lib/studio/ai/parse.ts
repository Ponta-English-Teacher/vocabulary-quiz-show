import { CEFR_LEVELS } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { coerceAskKind } from "@/lib/askQuestions";
import { EMPTY_BRIEF, MAX_SETS_PER_REQUEST, SET_SIZE, type Brief, type ChatMessage, type ChatResult, type StudioCommand } from "../types";
import { coerceGiverInfo, coerceJa, normalizeCefr, leaksTarget } from "../validation";
import type { VocabWord } from "@/data/vocab";
import { AiError, type StudioRequest } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, n: number, max: number) =>
  Array.isArray(v) ? v.map((x) => clip(x, max)).filter(Boolean).slice(0, n) : [];

/** Candidates arrive flat and/or grouped by familiarity. When grouped, the flat list is derived (so they never disagree). */
function sanitizeCandidates(raw: Record<string, unknown>, fallback: Brief): Pick<Brief, "candidates" | "candidateBands"> {
  const b = isObj(raw.candidateBands) ? raw.candidateBands : null;
  const bands = b
    ? { familiar: strList(b.familiar, 12, 60), moderate: strList(b.moderate, 12, 60), unfamiliar: strList(b.unfamiliar, 12, 60) }
    : fallback.candidateBands;
  const grouped = [...bands.familiar, ...bands.moderate, ...bands.unfamiliar];
  const flat = raw.candidates === undefined ? fallback.candidates : strList(raw.candidates, 20, 60);
  return { candidateBands: bands, candidates: (b && grouped.length ? grouped : flat).slice(0, 20) };
}

export function sanitizeBrief(raw: unknown, fallback: Brief = EMPTY_BRIEF): Brief {
  if (!isObj(raw)) return fallback;
  const sets = typeof raw.numSets === "number" && Number.isFinite(raw.numSets) ? Math.round(raw.numSets) : fallback.numSets;
  return {
    topic: raw.topic === undefined ? fallback.topic : clip(raw.topic, 120),
    level: raw.level === undefined ? fallback.level : normalizeCefr(raw.level),
    objectives: raw.objectives === undefined ? fallback.objectives : strList(raw.objectives, 6, 160),
    learnerFocus: raw.learnerFocus === undefined ? fallback.learnerFocus : clip(raw.learnerFocus, 500),
    numSets: Math.min(MAX_SETS_PER_REQUEST, Math.max(1, sets)),
    avoid: raw.avoid === undefined ? fallback.avoid : strList(raw.avoid, 20, 60),
    balance: raw.balance === undefined ? fallback.balance : clip(raw.balance, 300),
    approvalPending: raw.approvalPending === undefined ? fallback.approvalPending : raw.approvalPending === true,
    wordType: raw.wordType === undefined ? fallback.wordType : clip(raw.wordType, 120),
    ...sanitizeCandidates(raw, fallback),
    // Which words the teacher typed or deleted by hand: kept from the teacher's own brief, never from the model.
    pinnedCandidates: fallback.pinnedCandidates,
    removedCandidates: fallback.removedCandidates,
    // approvedWords is NEVER taken from the model — only the server sets it, on the teacher's approval.
    approvedWords: fallback.approvedWords,
  };
}

function parseCommand(raw: unknown): StudioCommand | null {
  if (!isObj(raw)) return null;
  const instruction = clip(raw.instruction, 300) || undefined;
  const position = typeof raw.position === "number" ? Math.round(raw.position) : NaN;
  const validPos = Number.isInteger(position) && position >= 1 && position <= SET_SIZE;
  switch (raw.type) {
    case "generate":
      return { type: "generate" };
    case "regenerate-set":
      return { type: "regenerate-set", instruction };
    case "replace-word":
      return validPos ? { type: "replace-word", position, instruction } : null;
    case "regenerate-hints":
      return validPos ? { type: "regenerate-hints", position, instruction } : null;
    default:
      return null;
  }
}

/** Validate the AI's chat reply. Anything unusable throws AiError('malformed'). */
export function parseChatResult(raw: unknown, prev: Brief): ChatResult {
  if (!isObj(raw)) throw new AiError("malformed", "The AI reply was not in the expected format.");
  const reply = clip(raw.reply, 2000);
  if (!reply) throw new AiError("malformed", "The AI reply was empty.");
  const brief = sanitizeBrief(raw.brief, prev);
  return {
    reply,
    brief,
    ready: raw.ready === true && brief.topic.length > 0,
    command: parseCommand(raw.command),
  };
}

/** Validate an incoming request body (never trust the client). */
export function parseStudioRequest(body: unknown): StudioRequest {
  const bad = (m: string) => new AiError("bad_request", m);
  if (!isObj(body)) throw bad("Request must be a JSON object.");
  const rawBrief = isObj(body.brief) ? body.brief : {};
  const brief: Brief = {
    ...sanitizeBrief(body.brief, EMPTY_BRIEF),
    // The teacher's brief is the source of truth for the list: words typed by hand are in it but in no familiarity group.
    ...(Array.isArray(rawBrief.candidates) ? { candidates: strList(rawBrief.candidates, 20, 60) } : {}),
    // The teacher's own edits to the candidate list travel with their brief (the model never sets these).
    pinnedCandidates: strList(rawBrief.pinnedCandidates, 40, 60),
    removedCandidates: strList(rawBrief.removedCandidates, 80, 60),
  };
  const forceMock = body.forceMock === true;
  const instruction = clip(body.instruction, 300) || undefined;

  const word = (v: unknown): VocabWord => {
    if (!isObj(v) || typeof v.word !== "string") throw bad("Invalid word.");
    return {
      id: clip(v.id, 40) || "x",
      word: clip(v.word, 60),
      accept: strList(v.accept, 8, 60),
      partOfSpeech: (["noun", "verb", "adjective", "adverb", "phrase"].includes(v.partOfSpeech as string) ? v.partOfSpeech : "noun") as VocabWord["partOfSpeech"],
      category: clip(v.category, 60),
      cefr: normalizeCefr(v.cefr) ?? "B1",
      meaning: clip(v.meaning, 300),
      example: clip(v.example, 300),
      hints: strList(v.hints, 3, 200),
      ...(coerceGiverInfo(v.giverInfo) ? { giverInfo: coerceGiverInfo(v.giverInfo) } : {}),
      ...(coerceJa(v.ja).length ? { ja: coerceJa(v.ja) } : {}),
      ...(coerceAskKind(v.askKind) ? { askKind: coerceAskKind(v.askKind) } : {}),
    };
  };

  switch (body.task) {
    case "chat": {
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw bad("No messages.");
      const messages: ChatMessage[] = body.messages
        .slice(-20)
        .flatMap((m): ChatMessage[] =>
          isObj(m) && (m.role === "teacher" || m.role === "ai") && typeof m.text === "string"
            ? [{ role: m.role, text: m.text.slice(0, 2000) }]
            : [],
        );
      if (!messages.length || messages[messages.length - 1].role !== "teacher") throw bad("The last message must be from the teacher.");
      let context: { words: { position: number; word: string; cefr: string }[] } | undefined;
      if (isObj(body.context) && Array.isArray(body.context.words)) {
        context = {
          words: body.context.words.slice(0, SET_SIZE).flatMap((w, i) =>
            isObj(w) ? [{ position: i + 1, word: clip(w.word, 60), cefr: clip(w.cefr, 3) }] : [],
          ),
        };
      }
      return { task: "chat", messages, brief, context, forceMock };
    }
    case "generate": {
      const count = typeof body.count === "number" ? Math.round(body.count) : SET_SIZE;
      return {
        task: "generate", brief, count: Math.min(SET_SIZE, Math.max(1, count)), exclude: strList(body.exclude, 200, 60),
        approved: strList(body.approved, SET_SIZE, 60), instruction, forceMock,
      };
    }
    case "replace-word":
      return { task: "replace-word", brief, current: word(body.current), exclude: strList(body.exclude, 200, 60), instruction, forceMock };
    case "regenerate-hints":
      return { task: "regenerate-hints", brief, word: word(body.word), instruction, forceMock };
    default:
      throw bad("Unknown task.");
  }
}

/** Validate a hint triple from the AI against the word it belongs to. */
export function parseHints(raw: unknown, target: Pick<VocabWord, "word" | "accept">): [string, string, string] {
  const arr = isObj(raw) ? raw.hints : raw;
  if (!Array.isArray(arr)) throw new AiError("malformed", "The AI did not return hints.");
  const hints = arr.map((h) => clip(h, 200)).filter(Boolean);
  if (hints.length < 3) throw new AiError("malformed", "The AI returned fewer than three hints.");
  const three = hints.slice(0, 3) as [string, string, string];
  if (three.some((h) => leaksTarget(target, h))) throw new AiError("validation", "A generated hint gave away the word.");
  if (new Set(three.map(normalize)).size < 3) throw new AiError("validation", "Generated hints were repeated.");
  return three;
}

export { CEFR_LEVELS };

/** The teacher asked to talk through candidates first / wait for their go-ahead. */
export const DISCUSS_FIRST_RE =
  /(wait for (my )?(approval|go[- ]?ahead|ok|confirmation)|before (you )?(generat|creat|mak)|(discuss|suggest|propose|show me)[^.]{0,60}(first|candidates|before)|first (suggest|discuss|propose|show)|don'?t generate (yet|anything)|not yet generate|candidates first)/i;
/** The teacher clearly gives the go-ahead. */
export const APPROVAL_RE =
  /\b(approved?|go ahead|generate( it| them| now| the set)?|looks? good|sounds? good|that works|perfect|proceed|do it|let'?s go|create (it|them|the set)|yes|ok(ay)?)\b/i;

/**
 * Server-side guard for "discuss first": whatever the model says, no generation command is
 * released while the teacher is still discussing, and it is released only on a clear approval.
 */
export function enforceApproval(result: ChatResult, prev: Brief, lastTeacherText: string): ChatResult {
  const discuss = DISCUSS_FIRST_RE.test(lastTeacherText);
  const held = discuss || prev.approvalPending;
  if (!held) return result;
  const approved = !discuss && APPROVAL_RE.test(lastTeacherText);
  if (approved) {
    if (result.command?.type !== "generate") return result; // the model asked something instead: keep the hold state it reports
    // Approval: freeze the candidate list the teacher just approved. Generation must use exactly these words.
    const approvedWords = (result.brief.candidates.length ? result.brief.candidates : prev.candidates).slice(0, 20);
    return { ...result, brief: { ...result.brief, approvalPending: false, approvedWords } };
  }
  return {
    ...result,
    brief: { ...result.brief, approvalPending: true, approvedWords: [] },
    command: result.command?.type === "generate" ? null : result.command,
  };
}

// ---- vocabulary mixture: the teacher asked for a range of difficulty -----------------------------------------

export type Band = "familiar" | "moderate" | "unfamiliar";

/** The teacher is asking for a spread of familiarity rather than one kind of word. */
export const RANGE_RE =
  /\b(mix(ture)?|range|variety|spread|both)\b|familiar[^.]{0,50}(challenging|unfamiliar|less common|uncommon|specialis|specializ)|(challenging|unfamiliar|less common|uncommon|specialis|specializ)[^.]{0,50}familiar/i;

/** Which bands did the teacher ask for? "challengingOnly" means they said "challenging" without saying which kind. */
export function requestedBands(text: string): { bands: Band[]; challengingOnly: boolean } {
  const t = text.toLowerCase();
  const found = new Set<Band>();
  if (/familiar|everyday|basic|already know|\b(?<!less )(?<!un)common\b/.test(t)) found.add("familiar");
  const explicitModerate = /moderate|medium|intermediate|somewhat|stretch/.test(t);
  const generalChallenging = /challenging/.test(t);
  if (explicitModerate) found.add("moderate");
  if (/unfamiliar|rare|specialis|specializ|less common|uncommon|never seen|new to them/.test(t)) found.add("unfamiliar");
  if (generalChallenging && !found.has("moderate") && !found.has("unfamiliar")) found.add("moderate");
  const vague = /\b(mix(ture)?|range|variety|spread)\b/.test(t) && found.size < 2;
  if (vague) return { bands: ["familiar", "moderate", "unfamiliar"], challengingOnly: false };
  return { bands: [...found], challengingOnly: generalChallenging && !explicitModerate && !/unfamiliar|rare|specialis|specializ|less common|uncommon/.test(t) };
}

/**
 * When the teacher asks for a range, the proposal must show examples from each requested band.
 * We never invent words or force a distribution: we add a plain heads-up so the teacher stays in control.
 */
export function enforceMixture(result: ChatResult, lastTeacherText: string): ChatResult {
  const text = `${lastTeacherText} ${result.brief.balance}`;
  if (!RANGE_RE.test(text) || result.brief.candidates.length === 0) return result;
  const { bands, challengingOnly } = requestedBands(text);
  const have = result.brief.candidateBands;
  const missing = bands.filter((b) => {
    if (b === "moderate" && challengingOnly) return have.moderate.length === 0 && have.unfamiliar.length === 0;
    return have[b].length === 0;
  });
  if (missing.length === 0) return result;
  const names = missing.map((b) => (b === "moderate" ? "moderately challenging" : b));
  return {
    ...result,
    reply: `${result.reply}\n\n(Heads-up: you asked for a range of difficulty, but my candidates don't yet include any ${names.join(" or ")} words. Tell me if you'd like some added — the balance is yours to set.)`,
  };
}

import type { VocabWord } from "@/data/vocab";
import { CEFR_LEVELS } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { SET_SIZE, type Brief, type ChatResult, type SetContext, type StudioCommand } from "../types";
import { MOCK_TOPICS, type BankEntry, type MockTopicKey } from "./mockBank";
import { APPROVAL_RE, DISCUSS_FIRST_RE, parseHints } from "./parse";
import { AiError } from "./types";
import { coerceWord, expectedPartsOfSpeech } from "../validation";

/**
 * MOCK AI — free, offline, clearly labelled in the UI.
 * It understands a handful of keywords and only knows the demo bank in mockBank.ts.
 * It exists so the Studio can be built and tested without a paid API.
 */

export const MOCK_TOPIC_NAMES = Object.values(MOCK_TOPICS).map((t) => t.label);

const LEVEL_RE = /\b([abc][12])\b/i;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

export function detectTopicKey(text: string): MockTopicKey | null {
  const t = text.toLowerCase();
  if (/fruit/.test(t)) return /less common|uncommon|unusual|rare|exotic|unfamiliar|tropical/.test(t) ? "fruits-uncommon" : "fruits-common";
  if (/physical|action|movement|gesture|body|exercise/.test(t)) return "actions";
  if (/personality|emotion|feeling|character|mood/.test(t)) return "personality";
  if (/expression|phrase|idiom|collocation|produce|speaking/.test(t)) return "expressions";
  return null;
}

const levelIndex = (l: string) => (CEFR_LEVELS as readonly string[]).indexOf(l);

/**
 * Pick demo words as a deliberate MIX across difficulty (familiar → challenging), not "closest to the level":
 * the activity level describes the conversation, not each word. `nearest` is used only to replace a single
 * word with one of similar difficulty so the set's mix is preserved.
 */
function pick(
  key: MockTopicKey,
  level: Brief["level"],
  exclude: string[],
  count: number,
  rng: () => number,
  opts: { nearest?: boolean; balance?: string } = {},
): BankEntry[] {
  const banned = new Set(exclude.map(normalize));
  const pool = MOCK_TOPICS[key].entries.filter((e) => ![e.word, ...(e.accept ?? [])].some((f) => banned.has(normalize(f))));
  const jitter = pool.map((e) => ({ e, r: rng() }));
  if (opts.nearest && level) {
    jitter.sort((a, b) => Math.abs(levelIndex(a.e.cefr) - levelIndex(level)) - Math.abs(levelIndex(b.e.cefr) - levelIndex(level)) || a.r - b.r);
    return jitter.slice(0, count).map((s) => s.e);
  }
  // ascending difficulty, stable; then take evenly spaced items so every band is represented
  jitter.sort((a, b) => levelIndex(a.e.cefr) - levelIndex(b.e.cefr) || a.r - b.r);
  const sorted = jitter.map((s) => s.e);
  if (count >= sorted.length) return sorted;
  // "mostly less common" teachers get the upper part of the range, but still with some familiar anchors
  const upper = /mostly less common/i.test(opts.balance ?? "");
  const start = upper ? Math.min(sorted.length - count, Math.floor(sorted.length * 0.25)) : 0;
  const window = sorted.slice(start);
  return Array.from({ length: count }, (_, i) => window[Math.round((i * (window.length - 1)) / Math.max(1, count - 1))]);
}

function asWords(entries: BankEntry[], level: Brief["level"]): VocabWord[] {
  return entries.flatMap((e) => {
    const c = coerceWord({ ...e, cefr: e.cefr });
    return "word" in c ? [c.word] : [];
  });
}

/** Mock stand-in for "write items for exactly these approved words": uses the demo bank entries with those words. */
export function mockApproved(approved: string[]): { words: VocabWord[]; issues: string[] } {
  const all = Object.values(MOCK_TOPICS).flatMap((t) => t.entries as BankEntry[]);
  const words: VocabWord[] = [];
  const missing: string[] = [];
  for (const a of approved) {
    const e = all.find((x) => normalize(x.word) === normalize(a));
    const c = e ? coerceWord({ ...e }) : null;
    if (c && "word" in c) words.push(c.word);
    else missing.push(a);
  }
  return {
    words,
    issues: missing.length ? [`Mock AI has no demo entry for: ${missing.join(", ")}. Real AI mode can write any approved word.`] : [],
  };
}

export function mockGenerate(brief: Brief, count: number, exclude: string[], rng: () => number = Math.random): VocabWord[] {
  const key = detectTopicKey(brief.topic);
  if (!key) {
    throw new AiError(
      "unsupported",
      `Mock AI only has demo vocabulary for: ${MOCK_TOPIC_NAMES.join(", ")}. Real AI mode can do any topic.`,
    );
  }
  const entries = pick(key, brief.level, exclude, count, rng, { balance: brief.balance });
  if (entries.length === 0) throw new AiError("unsupported", "Mock AI has run out of demo words for this topic. Real AI mode has no such limit.");
  return asWords(entries, brief.level);
}

export function mockReplace(brief: Brief, current: VocabWord, exclude: string[], rng: () => number = Math.random): VocabWord {
  // Replace with a word of similar difficulty so the set's mix of familiar and challenging words is kept.
  const key = detectTopicKey(brief.topic || current.category);
  if (!key) throw new AiError("unsupported", `Mock AI only has demo vocabulary for: ${MOCK_TOPIC_NAMES.join(", ")}. Real AI mode can do any topic.`);
  const banned = [...exclude, current.word, ...(current.accept ?? [])];
  const [entry] = pick(key, current.cefr, banned, 1, rng, { nearest: true });
  if (!entry) throw new AiError("unsupported", "Mock AI has run out of demo words for this topic. Real AI mode has no such limit.");
  return asWords([entry], current.cefr)[0];
}

/** Template hints (the mock can't write creative ones). The real AI writes proper hints. */
export function mockHints(word: VocabWord): [string, string, string] {
  const stem = word.word.slice(0, Math.max(3, word.word.length - 2));
  const masked = word.meaning.replace(new RegExp(`\\b${stem}\\w*`, "gi"), "___");
  const first = word.word[0].toUpperCase();
  const hints: [string, string, string] = [
    `Imagine a moment in everyday life connected with “${word.category}”.`,
    `Think about this meaning: ${masked.charAt(0).toLowerCase()}${masked.slice(1)}`,
    `It is a ${word.partOfSpeech === "phrase" ? "phrase" : word.partOfSpeech} that starts with “${first}”.`,
  ];
  return parseHints(hints, word);
}

// ---- chat -------------------------------------------------------------------

function parseNumSets(text: string): number | null {
  const m = text.toLowerCase().match(/\b(\d+|one|two|three|four|five)\s+(?:ten[- ]word\s+)?sets?\b/);
  if (!m) return null;
  const n = NUMBER_WORDS[m[1]] ?? parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null;
}

function detectCommand(text: string, hasSet: boolean, ready: boolean, holdGenerate = false): StudioCommand | null {
  const t = text.toLowerCase().trim();
  const pos = t.match(/(?:#|no\.?|number|word)\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\b/);
  const n = pos ? parseInt(pos[1] ?? pos[2], 10) : NaN;
  const validPos = Number.isInteger(n) && n >= 1 && n <= SET_SIZE;
  if (hasSet && validPos && /\bhints?\b/.test(t)) return { type: "regenerate-hints", position: n, instruction: text.trim() };
  if (hasSet && validPos && /\b(replace|swap|change|different|another|new)\b/.test(t)) return { type: "replace-word", position: n, instruction: text.trim() };
  if (hasSet && /\b(regenerate|redo|start over|try again|new set|different words|another set)\b/.test(t)) return { type: "regenerate-set", instruction: text.trim() };
  if (ready && !holdGenerate && /^(please )?(generate|go ahead|go|yes|ok|okay|do it|create it|make it|sounds good|looks good|let'?s go)\b/.test(t)) return { type: "generate" };
  return null;
}

export function mockChat(messages: { role: string; text: string }[], prev: Brief, context?: SetContext): ChatResult {
  const last = messages[messages.length - 1].text;
  const lower = last.toLowerCase();
  const brief: Brief = { ...prev };
  const notes: string[] = [];

  const lvl = last.match(LEVEL_RE);
  if (lvl) brief.level = lvl[1].toUpperCase() as Brief["level"];
  const key = detectTopicKey(last);
  if (key) {
    brief.topic = MOCK_TOPICS[key].label;
  }
  const sets = parseNumSets(last);
  if (sets) brief.numSets = sets;
  if (/japan/.test(lower)) {
    brief.learnerFocus = last.trim().slice(0, 300);
    notes.push("Noted: your students are Japanese — I'll favour words they can recognise but find hard to say.");
  }

  if (/(familiar|everyday|common)/.test(lower) && /(less common|uncommon|specialis|specializ|challenging|rare)/.test(lower)) {
    brief.balance = "A real mix of familiar everyday words and less common/specialised words";
  } else if (/less common|uncommon|specialis|specializ/.test(lower) && key) {
    brief.balance = "Mostly less common words";
  }

  const ready = !!brief.topic && !!brief.level;
  const discuss = DISCUSS_FIRST_RE.test(last);
  const held = discuss || prev.approvalPending;
  const approving = held && !discuss && APPROVAL_RE.test(last);
  brief.approvalPending = held && !approving;
  const askedAboutPictures = /\b(pictures?|images?|photos?|visuals?|illustrations?|drawings?)\b/.test(lower);
  const command = askedAboutPictures
    ? null
    : detectCommand(last, !!context && context.words.length > 0, ready, held && !approving);

  let reply: string;
  if (askedAboutPictures) {
    reply =
      "Yes — pictures and visual clues are part of the intended hint design, alongside spoken descriptions, situational examples, hints the students make up themselves, and AI help when a Giver can't explain a word. Picture hints are a planned future feature and are NOT available yet; today the hints are text the Giver says aloud, plus the Giver's own spoken hints.";
  } else if (held && !approving && brief.topic && brief.level) {
    const k = detectTopicKey(brief.topic);
    const entries = k ? pick(k, brief.level, [], 9, () => 0, { balance: brief.balance }) : [];
    // Groups describe how familiar the words probably are to students — a rough guide, never a CEFR rule.
    const bands: Brief["candidateBands"] = { familiar: [], moderate: [], unfamiliar: [] };
    for (const e of entries) {
      const b = e.cefr === "A1" || e.cefr === "A2" ? "familiar" : e.cefr === "B1" || e.cefr === "B2" ? "moderate" : "unfamiliar";
      bands[b].push(e.word);
    }
    brief.candidateBands = bands;
    brief.candidates = [...bands.familiar, ...bands.moderate, ...bands.unfamiliar];
    const kind = k ? expectedPartsOfSpeech(brief.topic) : null;
    if (kind) brief.wordType = kind.label;
    const lines = (
      [["Familiar", bands.familiar], ["Moderately challenging", bands.moderate], ["Unfamiliar", bands.unfamiliar]] as const
    )
      .filter(([, w]) => w.length)
      .map(([label, w]) => `${label}: ${w.join(", ")}`);
    reply = brief.candidates.length
      ? `Candidates for “${brief.topic}”${brief.wordType ? ` (${brief.wordType})` : ""}${brief.balance ? `, balance: ${brief.balance.toLowerCase()}` : ""}:\n${lines.join("\n")}\n\nHow this helps communication: the familiar words are tools for explaining — the Giver can describe an unfamiliar word using them, and the Taker can ask questions (what is it for? what does it look like? where do you find it?) and negotiate meaning together. The mix is yours to set; I'm not sorting by CEFR level. Tell me what to add, drop or swap — I won't generate until you approve.`
      : "(mock AI has no list for this topic)";
  } else if (command) {
    reply =
      command.type === "generate"
        ? `Great — generating ${brief.numSets} set${brief.numSets > 1 ? "s" : ""} of ten now.`
        : command.type === "regenerate-set"
          ? "Okay, regenerating the set. Locked words will stay exactly as they are."
          : command.type === "replace-word"
            ? `Okay, replacing word #${command.position}. The other nine stay untouched.`
            : `Okay, writing fresh hints for word #${command.position}.`;
  } else if (!brief.topic) {
    reply = `What would you like the words to be about? For example: “common fruits”, “everyday physical actions”, “personality and emotions” or “useful everyday expressions”. (Mock AI knows: ${MOCK_TOPIC_NAMES.join(", ")}.)`;
  } else if (!brief.level) {
    reply = `${brief.topic} — nice. Which CEFR level should I aim for (A1–C2)? Tell me roughly what your students can already do and I'll calibrate.`;
  } else {
    const extra = brief.learnerFocus ? "" : " One question: do your students mostly need to recognise these words, or to produce them in speaking?";
    reply = `${[...notes, ""].join(" ").trim()} Here's the plan: ${brief.numSets} ten-word set${brief.numSets > 1 ? "s" : ""} on “${brief.topic}” at ${brief.level}.${extra} Tell me to adjust anything, or say “generate” (or press Generate).`.trim();
  }
  return { reply, brief, ready, command };
}

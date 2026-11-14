import { CEFR_LEVELS, PARTS_OF_SPEECH, type CefrLevel } from "@/data/vocab";
import { BANK_FORMAT, BANK_VERSION } from "./types";
import { BANK_LIMITS } from "./validate";
import type { ImportFormat } from "./import";

/**
 * Downloadable templates and the copy-paste prompt for writing VQS words OUTSIDE the app (ChatGPT, Claude, or by hand).
 * No AI is called here: this only produces text for the teacher to copy.
 */
export const TEMPLATE_ROWS = [
  {
    word: "colander",
    accept: ["strainer"],
    partOfSpeech: "noun",
    category: "Kitchen tools",
    level: "B1",
    topic: "Cooking",
    giverJa: "水切りざる",
    meaning: "A bowl with holes that you use to drain water from food.",
    example: "Pour the pasta into the colander.",
    hints: [
      "You use this in the kitchen after you boil something.",
      "It is a bowl with a lot of small holes in it.",
      "The water goes out through the holes, but the food stays inside.",
      "You pour boiled pasta into it to take the water away.",
    ],
  },
  {
    word: "exhausted",
    accept: [],
    partOfSpeech: "adjective",
    category: "Feelings",
    level: "B1",
    topic: "Body and mind",
    giverJa: "ぐったり疲れた",
    hints: [
      "Imagine you ran a long way, or worked all day without a break.",
      "At the end, you cannot move much and you want to lie down.",
      "It is stronger than being tired.",
      "You feel this when you have no energy left at all.",
    ],
  },
] as const;

export const templateJson = (): string => JSON.stringify({ format: BANK_FORMAT, version: BANK_VERSION, words: TEMPLATE_ROWS }, null, 2) + "\n";

export const CSV_COLUMNS = ["word", "accept", "partOfSpeech", "category", "level", "topic", "giverJa", "meaning", "example", "hint1", "hint2", "hint3", "hint4"] as const;

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function templateCsv(): string {
  const rows = TEMPLATE_ROWS.map((r) => {
    const w = r as unknown as { word: string; accept: readonly string[]; partOfSpeech: string; category: string; level: string; topic?: string; giverJa?: string; meaning?: string; example?: string; hints: readonly string[] };
    return [w.word, w.accept.join(";"), w.partOfSpeech, w.category, w.level, w.topic ?? "", w.giverJa ?? "", w.meaning ?? "", w.example ?? "", ...w.hints].map(csvCell).join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export function templateFile(format: ImportFormat): { filename: string; mime: string; content: string } {
  return format === "json"
    ? { filename: "vqs-words-template.json", mime: "application/json", content: templateJson() }
    : { filename: "vqs-words-template.csv", mime: "text/csv", content: "﻿" + templateCsv() };
}

export const LEVEL_NOTES: Record<CefrLevel, string> = {
  A1: "only the most common everyday words; sentences of about 5 to 8 words; no idioms",
  A2: "common everyday words; short sentences of up to about 10 words; no idioms",
  B1: "clear everyday English; sentences of up to about 14 words; a less common word only if the hint explains it",
  B2: "natural English; sentences of up to about 18 words; topic words are fine",
  C1: "advanced English; sentences of up to about 22 words",
  C2: "precise English; sentences of up to about 25 words",
};

export interface PromptOptions {
  level: CefrLevel | "Mixed";
  /** A topic or category, e.g. "Kitchen tools". Empty = the writer chooses a variety. */
  topic?: string;
  size: number;
  format: ImportFormat;
  /** Words to avoid (already in the bank). */
  existingWords?: readonly string[];
  /** Include a Japanese meaning for the Giver. Default true. */
  giverJa?: boolean;
}

/** A ready-to-paste prompt that makes ChatGPT or Claude produce a file the VQS importer accepts. */
export function buildGenerationPrompt(o: PromptOptions): string {
  const topic = (o.topic ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const level = o.level === "Mixed" ? `Spread the words across CEFR levels ${CEFR_LEVELS.join(", ")}.` : `Every word is CEFR level ${o.level}: write the hints in English a ${o.level} learner can understand (${LEVEL_NOTES[o.level]}).`;
  const avoid = (o.existingWords ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 300);
  const ja = o.giverJa !== false;
  const example = o.format === "json" ? JSON.stringify(TEMPLATE_ROWS[0], null, 2) : `${CSV_COLUMNS.join(",")}\n${templateCsv().split("\r\n")[1]}`;
  const output = o.format === "json"
    ? "Return ONLY a JSON array of word objects. No introduction, no markdown code fences, no comments."
    : "Return ONLY CSV text: the header row exactly as in the example, then one row per word. Put quotation marks around any cell containing a comma. No introduction, no code fences.";

  return `You are an experienced English teacher writing words for a spoken vocabulary game for Japanese learners of English.

How the game works: two students play on two phones. The GIVER sees the target word and explains it ALOUD in English, using the hints you write. The TAKER cannot see the word and guesses. Students speak to each other; the hints are what the Giver says. The Giver reads hint 1 first, and further hints cost the pair points, so the hints go from LEAST helpful to MOST helpful.

Write ${o.size} words${topic ? ` about "${topic}"` : " on a variety of everyday and school-life topics"}.
${level}

Each word has FOUR hints:
- Hint 1 (free, the opening): a situation or scene the Giver can start talking about. It is the LEAST helpful hint but must not be vague or obscure. Not a bare label ("It is a kitchen tool."), and avoid numbers, dates and trivia.
- Hint 2: one more concrete detail (what it looks like, what happens, who uses it).
- Hint 3: a clearer clue, such as how it is used or a contrast.
- Hint 4: the MOST helpful hint. A student who has heard it should be able to guess the word.
- Every hint is ONE short, natural spoken sentence (${BANK_LIMITS.hintWordsMin}-${BANK_LIMITS.hintWordsMax} words, under ${BANK_LIMITS.hintMax} characters) that a student can say out loud. Each hint adds NEW information. Do not repeat or reword an earlier hint.
- NEVER write the target word, or a form of it (plural, past tense, part of a compound word), in any hint. Do not give a translation, the first letter, the number of letters, or "rhymes with". Do not rely on a picture.
- Hints must be true and easy to say. Use simple words; if an idea needs a difficult word, describe it with easier words.

Each word also needs:
- word: the target word or phrase (maximum ${BANK_LIMITS.word} characters)
- accept: a list of other spellings or forms that count as correct (for example "colour" and "color"); an empty list is fine
- partOfSpeech: one of ${PARTS_OF_SPEECH.join(", ")}
- category: a short topic label (maximum ${BANK_LIMITS.category} characters)
- level: ${CEFR_LEVELS.join(", ")}
- topic: optional, a narrower topic
${ja ? `- giverJa: a SHORT natural Japanese equivalent (maximum ${BANK_LIMITS.giverJa} characters). It is shown to the Giver only, to confirm the meaning. Never put it in a hint.\n` : ""}- meaning: optional, a one-sentence plain-English meaning for the Giver
- example: optional, one example sentence for the Giver
- Do NOT include a status field: every word starts as a draft and the teacher approves it.

Rules:
- Choose useful words students are likely to meet and can explain in English. Avoid people's names, brands, titles, and words that need a picture.
- Do not repeat a word within this list.${avoid.length ? `\n- Do not use any of these words, which are already in the bank: ${avoid.join(", ")}.` : ""}

Before you answer, check EVERY word and fix any problem: (1) no hint contains the word or a form of it; (2) hints get steadily more helpful; (3) no hint repeats another; (4) every hint is a short sentence a student can say; (5) every fact is true; (6) the level suits the learners. Do not show this check. Output only the final file.

${output}

Example of ONE word in the required format:
${example}
`;
}

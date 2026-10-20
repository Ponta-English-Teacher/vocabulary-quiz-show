import type { VocabWord } from "@/data/vocab";

/**
 * What the Giver sees besides the definition: how to talk about the word.
 * Uses the optional `giverInfo` written with the word; older sets don't have it, so every part has a fallback
 * and nothing here ever needs AI at play time.
 */
export interface GiverNotes {
  looksLabel: string;
  looks: string | null;
  useLabel: string;
  use: string | null;
  /** Short, speakable sentence starters (the word's own, or generic ones for its part of speech). */
  phrases: string[];
  /** True when the word carries its own notes (false = only generic starters are available). */
  custom: boolean;
}

const GENERIC_PHRASES: Record<VocabWord["partOfSpeech"], string[]> = {
  noun: ["It is a thing that...", "You use it when...", "It looks like...", "It has..."],
  verb: ["It is something you do when...", "You do this to...", "It means to...", "For example, ..."],
  adjective: ["It describes a person or thing that...", "You can say this when...", "It is the opposite of...", "It feels like..."],
  adverb: ["It tells us how, when or where...", "You can say it with...", "It is like...", "For example, ..."],
  phrase: ["People say this when...", "It means...", "You can say it to...", "For example, ..."],
};

/** Headings adapt to the kind of word, so an action or a feeling is not forced into an object template. */
const LABELS: Record<VocabWord["partOfSpeech"], { looks: string; use: string }> = {
  noun: { looks: "What it looks like", use: "How it is used" },
  verb: { looks: "What you would see", use: "When people do it" },
  adjective: { looks: "What you would see", use: "When you feel or say it" },
  adverb: { looks: "What you would see", use: "How it is used" },
  phrase: { looks: "What you would see", use: "When people say it" },
};

export function giverNotesFor(word: Pick<VocabWord, "partOfSpeech" | "giverInfo">): GiverNotes {
  const info = word.giverInfo;
  const labels = LABELS[word.partOfSpeech] ?? LABELS.noun;
  const own = (info?.phrases ?? []).filter((p) => p.trim());
  return {
    looksLabel: labels.looks,
    looks: info?.looks?.trim() || null,
    useLabel: labels.use,
    use: info?.use?.trim() || null,
    phrases: own.length ? own : GENERIC_PHRASES[word.partOfSpeech] ?? GENERIC_PHRASES.noun,
    custom: Boolean(info?.looks?.trim() || info?.use?.trim() || own.length),
  };
}

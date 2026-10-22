import type { PartOfSpeech } from "@/data/vocab";

/**
 * Question ideas for the Taker, chosen by the KIND of word in play. Nothing here needs AI at play time and nothing
 * contains (or can contain) the secret word: the lists are fixed, generic sentences. The only word data they use is
 * the part of speech, the topic label (both already visible to the Taker) and an optional teacher-set `askKind`.
 */
export const ASK_KINDS = ["object", "action", "feeling", "quality", "concept", "expression", "manner"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const ASK_KIND_LABELS: Record<AskKind, string> = {
  object: "A thing (something you can see or touch)",
  action: "An action (something people do)",
  feeling: "A feeling or attitude",
  quality: "A description (how something looks, feels or is made)",
  concept: "An idea or abstract concept",
  expression: "An expression (something people say)",
  manner: "A manner (how, when or where something happens)",
};

export const isAskKind = (v: unknown): v is AskKind => typeof v === "string" && (ASK_KINDS as readonly string[]).includes(v);

export const coerceAskKind = (v: unknown): AskKind | undefined => (isAskKind(v) ? v : undefined);

const FEELING_TOPIC = /\b(feelings?|emotions?|moods?|attitudes?|character|personality|personalities|behaviou?rs?|manners|temperament)\b/i;
const ABSTRACT_TOPIC =
  /\b(ideas?|concepts?|abstract|society|social|business|work|study|school|money|finance|shopping|economy|economics|politics|law|education|time|time management|communication|relationships?|health|environment)\b/i;

/** The kind of word, from the teacher's `askKind` if there is one, otherwise from part of speech + topic label. */
export function resolveAskKind(word: { askKind?: unknown; partOfSpeech: PartOfSpeech; category?: string }): AskKind {
  const own = coerceAskKind(word.askKind);
  if (own) return own;
  const topic = word.category ?? "";
  switch (word.partOfSpeech) {
    case "verb":
      return "action";
    case "phrase":
      return "expression";
    case "adverb":
      return "manner";
    case "adjective":
      return FEELING_TOPIC.test(topic) ? "feeling" : "quality";
    default:
      return FEELING_TOPIC.test(topic) || ABSTRACT_TOPIC.test(topic) ? "concept" : "object";
  }
}

const QUESTIONS: Record<AskKind, string[]> = {
  object: [
    "What does it look like?",
    "What do you do with it?",
    "Where can I find it?",
    "What is it made of?",
    "How big is it?",
    "Do you use it every day?",
  ],
  action: [
    "What is someone doing?",
    "When might someone do this?",
    "Where might someone do this?",
    "Can you act it out?",
    "Do you need anything to do it?",
    "Is it a fast or a slow action?",
  ],
  feeling: [
    "How does the person feel?",
    "Do they want to do something?",
    "Is it a good or a bad feeling?",
    "When might someone feel this?",
    "What might the person say or do?",
    "Can you give me an example situation?",
  ],
  quality: [
    "What kind of thing is it usually used to describe?",
    "Can you give me an example?",
    "Is it something you can see or touch?",
    "Does it have an opposite?",
    "Is it a good or a bad thing to be?",
    "Can you act it out?",
  ],
  concept: [
    "Can you give me an example?",
    "Is it related to people's behavior?",
    "When do people talk about it?",
    "Is it something good, bad, or neither?",
    "Is it related to money, work, or time?",
    "Does it have an opposite?",
  ],
  expression: [
    "When would someone say this?",
    "What does it mean in that situation?",
    "Is it polite or casual?",
    "Who might say it to whom?",
    "Can you say it in a sentence?",
    "What would the other person answer?",
  ],
  manner: [
    "How does something happen?",
    "When would you use it?",
    "Can you give me an example sentence?",
    "Is it a fast or a slow way?",
    "Does it have an opposite?",
  ],
};

/** The prompts for this word, in a fixed, natural order. Always at least four. */
export function questionsFor(word: { askKind?: unknown; partOfSpeech: PartOfSpeech; category?: string }): string[] {
  return QUESTIONS[resolveAskKind(word)];
}

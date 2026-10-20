/**
 * Vocabulary data — edit this file to change the game's content.
 *
 * The shape is deliberately future-proof:
 *  - `category` and `cefr` are per-word fields, ready for filtering/selection UIs.
 *  - Words live inside a `VocabSet`; add more sets to VOCAB_SETS and a set picker later.
 *  - Everything is plain JSON-serialisable data (it can later come from a file or database).
 */

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const PARTS_OF_SPEECH = ["noun", "verb", "adjective", "adverb", "phrase"] as const;
export type PartOfSpeech = (typeof PARTS_OF_SPEECH)[number];

export interface VocabWord {
  /** Stable unique id (used for game state, never shown). Keep it opaque — it must not reveal the word. */
  id: string;
  /** The target word, as the Giver sees it. */
  word: string;
  /** Extra spellings that count as correct (e.g. "colour" / "color"). */
  accept?: string[];
  /** "phrase" covers multi-word expressions, idioms and collocations. */
  partOfSpeech: PartOfSpeech;
  /** Free-text topic label. Shown to the Taker as a free clue. */
  category: string;
  cefr: CefrLevel;
  /** Plain-English explanation for the Giver. */
  meaning: string;
  /** Example sentence for the Giver (may contain the word). */
  example: string;
  /** Prepared hints, ordered from hardest to easiest. Never contain the word. */
  hints: string[];
}

export interface VocabSet {
  id: string;
  title: string;
  description: string;
  words: VocabWord[];
}

export const SAMPLE_SET: VocabSet = {
  id: "sample-mixed-1",
  title: "Sample Set — Mixed",
  description: "Ten everyday and challenging words (A2–C1) for the first prototype.",
  words: [
    {
      id: "w01",
      word: "umbrella",
      partOfSpeech: "noun",
      category: "Everyday objects",
      cefr: "A2",
      meaning: "An object you hold over your head to keep dry when it rains.",
      example: "Don't forget your umbrella — it's going to rain this afternoon.",
      hints: [
        "You carry it on certain kinds of weather days.",
        "It has a handle and folds up small.",
        "It starts with the letter U.",
      ],
    },
    {
      id: "w02",
      word: "scissors",
      partOfSpeech: "noun",
      category: "Everyday objects",
      cefr: "A2",
      meaning: "A tool with two blades that you use to cut paper or cloth.",
      example: "Can I borrow your scissors to open this package?",
      hints: [
        "You find it in a desk drawer or a pencil case.",
        "It has two handles with holes for your fingers.",
        "It is used for cutting paper — snip, snip!",
      ],
    },
    {
      id: "w03",
      word: "whisper",
      partOfSpeech: "verb",
      category: "Actions",
      cefr: "B1",
      meaning: "To speak very quietly so that only a person close to you can hear.",
      example: "She leaned over and whispered a secret in my ear.",
      hints: [
        "It is a way of using your voice.",
        "You do this in a library, or when you tell a secret.",
        "It is the opposite of shout.",
      ],
    },
    {
      id: "w04",
      word: "borrow",
      partOfSpeech: "verb",
      category: "Actions",
      cefr: "A2",
      meaning: "To take something from someone and promise to give it back later.",
      example: "Can I borrow your pen? I'll give it back after class.",
      hints: [
        "It happens between two people, or with a library.",
        "You must return the thing afterwards.",
        "Its opposite is 'lend'.",
      ],
    },
    {
      id: "w05",
      word: "deadline",
      partOfSpeech: "noun",
      category: "Study & work",
      cefr: "B1",
      meaning: "The last day or time by which something must be finished.",
      example: "The deadline for the report is Friday at noon.",
      hints: [
        "Students and workers often feel stress about it.",
        "It is a point in time, not a place or a thing.",
        "Your essay must be handed in before this.",
      ],
    },
    {
      id: "w06",
      word: "reluctant",
      partOfSpeech: "adjective",
      category: "Feelings & character",
      cefr: "B2",
      meaning: "Not wanting to do something, and slow to agree to do it.",
      example: "He was reluctant to sing in front of the whole class.",
      hints: [
        "It describes how a person feels before doing something.",
        "You might feel this about going to the dentist.",
        "It means 'unwilling' or 'not keen'. It starts with R.",
      ],
    },
    {
      id: "w07",
      word: "bargain",
      partOfSpeech: "noun",
      category: "Shopping",
      cefr: "B2",
      meaning: "Something you buy for much less than its usual price.",
      example: "These shoes were only 20 dollars — what a bargain!",
      hints: [
        "You are happy when you find one in a shop.",
        "It is connected with sales and discounts.",
        "It is a very good price. It starts with B.",
      ],
    },
    {
      id: "w08",
      word: "nostalgic",
      partOfSpeech: "adjective",
      category: "Feelings & character",
      cefr: "C1",
      meaning: "Feeling happy and a little sad when you remember the past.",
      example: "Looking at old school photos made her feel nostalgic.",
      hints: [
        "Old songs, photos or toys can cause this feeling.",
        "It is a mix of happy and sad.",
        "You feel this when you miss your childhood. It starts with N.",
      ],
    },
    {
      id: "w09",
      word: "procrastinate",
      partOfSpeech: "verb",
      category: "Study & work",
      cefr: "C1",
      meaning: "To keep delaying something you should do, usually because you don't want to do it.",
      example: "I always procrastinate instead of starting my homework.",
      hints: [
        "Many students do this the night before an exam.",
        "You watch videos instead of studying.",
        "It means to put off a task until later. It starts with P.",
      ],
    },
    {
      id: "w10",
      word: "suitcase",
      accept: ["suit case"],
      partOfSpeech: "noun",
      category: "Travel",
      cefr: "A2",
      meaning: "A large bag with a handle that you use to carry clothes when you travel.",
      example: "She packed her suitcase the night before the trip.",
      hints: [
        "You see lots of these at an airport.",
        "It often has wheels and a handle.",
        "You pack your clothes in it for a holiday.",
      ],
    },
  ],
};

/** All available sets. Add more here; a set picker can be built on top later. */
export const VOCAB_SETS: VocabSet[] = [SAMPLE_SET];

export const DEFAULT_SET: VocabSet = SAMPLE_SET;

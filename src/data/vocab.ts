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

/**
 * A private picture for the Giver (never shown to the Taker during a round, never a hint, never costs points).
 * `src` is an inline image data URL made in Teacher Studio. In a hosted class the picture is moved out of the
 * activity into its own storage key and `src` is "" in the stored word (a marker meaning "a picture exists");
 * the server puts the real `src` into the GIVER's view of the word in play only.
 */
export interface Illustration {
  src: string;
  /** Short description for screen readers. */
  alt?: string;
}

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
  /**
   * Prepared hints. Hint 1 is the OPENING hint: it is shown to the GIVER only (never the Taker) automatically when the round
   * starts and is free. Hints 2 and 3 are optional and cost points. None of them contain the word.
   */
  hints: string[];
  /**
   * Optional kind of word (thing / action / feeling / description / idea / expression / manner). It picks the question ideas
   * the Taker sees. Teacher-editable; when missing (older sets) it is worked out from the part of speech and topic.
   * It is a coarse label, so it is safe to show the Taker.
   */
  askKind?: "object" | "action" | "feeling" | "quality" | "concept" | "expression" | "manner";
  /** Optional private picture for the Giver. Older sets lack it. */
  illustration?: Illustration;
  /** Optional Giver-only support: simple English the Giver can use to answer questions. Older sets lack it. */
  giverInfo?: GiverInfo;
  /**
   * Approved Japanese equivalents (e.g. ["ざる", "水切りざる"]). SERVER-SIDE answer data: it is never sent to the
   * Taker (or the Giver) while the word is in play. Empty or missing = no Japanese credit for this word.
   */
  ja?: string[];
  /**
   * Japanese meanings for the student STUDY page only. Filled in automatically for vocabulary that has no `ja`, and teacher-editable.
   * Never used for scoring and never sent to a player's phone during a game (the game strips it when it starts).
   */
  studyJa?: string[];
}

/** Giver-only support for explaining a word naturally. Every field is optional and adapts to the kind of word. */
export interface GiverInfo {
  /** What it looks like (objects) or what you would see happening (actions). Left out for abstract words. */
  looks?: string;
  /** How it is used, when it happens, or when people say it. */
  use?: string;
  /** Two to four short, speakable sentence starters ("It looks like...", "You use it when..."). */
  phrases?: string[];
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
        "You open this when you walk outside and the rain starts to fall.",
        "It has a handle and a round cover on top. It folds up small.",
        "A raincoat keeps you dry too, but this one you hold in your hand.",
      ],
      giverInfo: {
        looks: "It has a long handle and a round cover on top. It opens and closes.",
        use: "You hold it over your head when it rains. You keep it in your bag when it is sunny.",
        phrases: ["It looks like...", "You use it when...", "It has...", "You hold it..."],
      },
      ja: ["傘", "かさ"],
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
        "You take this out when you open a package or cut a picture from paper.",
        "It has two handles with holes for your fingers.",
        "It has two sharp blades that work together — snip, snip!",
      ],
      giverInfo: {
        looks: "It has two sharp blades and two handles. The handles have holes for your fingers.",
        use: "You hold the handles and open and close them. The blades cut paper, cloth or hair.",
        phrases: ["It looks like...", "You use it to cut...", "It has two...", "You hold it with..."],
      },
      ja: ["はさみ", "鋏"],
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
        "You do this in a library, or when you tell a friend a secret.",
        "You use your voice, but it is very quiet and soft.",
        "It is the opposite of shout.",
      ],
      giverInfo: {
        looks: "The person moves close to your ear. They speak very, very quietly.",
        use: "You do this when you do not want other people to hear. You do it in a quiet place.",
        phrases: ["It is a way to speak...", "You do this when...", "It is the opposite of..."],
      },
      ja: ["ささやく", "囁く", "ささやき"],
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
        "You forget your pen, so you ask a friend to give you one for a short time.",
        "You must give the thing back after you use it.",
        "Its opposite is 'lend'.",
      ],
      giverInfo: {
        looks: "One person gives something to another person for a short time. Later, it goes back.",
        use: "You do this with a book from the library or a pen from a friend. You ask: 'Can I use your pen for a minute?'",
        phrases: ["It is when you take something...", "You must give it back...", "You do this when..."],
      },
      ja: ["借りる", "かりる", "借ります"],
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
        "Your teacher says your report is due on Friday at noon, and you feel stressed.",
        "It is a day and a time, not a place or a thing.",
        "If you finish after this time, you are late.",
      ],
      giverInfo: {
        use: "Teachers and bosses give you this for homework or work. It is the last day or time to finish.",
        phrases: ["It is a time...", "You have to finish before...", "If you are late..."],
      },
      ja: ["締め切り", "締切", "しめきり", "期限"],
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
        "The teacher asks you to sing in front of the whole class, but you do not really want to.",
        "You feel this before you do something you do not like. You move slowly.",
        "It means 'unwilling'. You say yes, but only after a long time.",
      ],
      giverInfo: {
        looks: "The person looks slow and nervous. They do not smile much.",
        use: "You feel this about going to the dentist, or speaking in front of many people.",
        phrases: ["It describes a person who...", "You feel this when...", "It is like saying 'I don't want to...'"],
      },
      ja: ["気が進まない", "気乗りしない", "乗り気でない", "渋々", "しぶしぶ", "いやいや", "嫌々"],
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
        "You find a nice pair of shoes in a shop, and they cost much less than usual.",
        "It is connected with sales and discounts.",
        "It is a very good price, and it makes you happy when you buy it.",
      ],
      giverInfo: {
        use: "You say it when you buy something good for a low price. Shops have it in a sale.",
        phrases: ["It is something you buy...", "It costs less than...", "You feel happy because..."],
      },
      ja: ["お買い得", "お買い得品", "掘り出し物", "バーゲン"],
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
        "You find an old photo from your school days. You smile, but you also feel a little sad.",
        "It is a mix of happy and sad feelings about the past.",
        "You feel this when you miss your childhood days.",
      ],
      giverInfo: {
        looks: "The person smiles softly and looks at old photos or toys.",
        use: "Old songs, photos, toys or food can give you this feeling. It is about the past.",
        phrases: ["It is a feeling...", "You feel this when you remember...", "It is happy and sad together."],
      },
      ja: ["懐かしい", "なつかしい", "ノスタルジック", "懐かしむ"],
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
        "It is the night before an exam, and you are watching videos instead of studying.",
        "You know you should do the work, but you keep waiting.",
        "It means to put off a task until later.",
      ],
      giverInfo: {
        looks: "A person sits at a desk. They check their phone again and again. The work is still not done.",
        use: "Many students do this before a test or a report. They do other things first.",
        phrases: ["It is when you wait to do...", "You know you should..., but you...", "You do it later and later."],
      },
      ja: ["先延ばしにする", "先延ばしする", "先送りにする", "後回しにする", "ぐずぐずする"],
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
        "You see people pulling these through the airport before a trip.",
        "It often has wheels and a handle.",
        "You pack your clothes in it for a holiday.",
      ],
      giverInfo: {
        looks: "It is a big box-shaped bag. It often has wheels and a long handle.",
        use: "You put your clothes inside before a trip. You pull it at the airport or the station.",
        phrases: ["It looks like...", "You use it when you...", "You put ... inside.", "It has wheels and..."],
      },
      ja: ["スーツケース", "旅行かばん", "キャリーケース", "キャリーバッグ"],
    },
  ],
};

/** All available sets. Add more here; a set picker can be built on top later. */
export const VOCAB_SETS: VocabSet[] = [SAMPLE_SET];

export const DEFAULT_SET: VocabSet = SAMPLE_SET;

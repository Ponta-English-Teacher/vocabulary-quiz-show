import { describe, expect, it } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { EMPTY_BRIEF, type Activity } from "./types";
import { generatePrompt, hintsPrompt } from "./ai/prompts";
import { parseStudioRequest } from "./ai/parse";
import { loadActivities, saveActivity, STORAGE_KEY, type StorageLike } from "./storage";
import { coerceJa, coerceWord, isVagueOpeningHint, parseGeneratedWords, validateWord } from "./validation";
import { leaksTarget } from "./validation";

const raw = (over: Record<string, unknown> = {}) => ({
  word: "colander", partOfSpeech: "noun", cefr: "B2", category: "Kitchen tools",
  meaning: "A bowl with many small holes for draining water from food.",
  example: "She poured the pasta into a colander.",
  hints: ["You often need this after boiling pasta or washing vegetables.", "It has a lot of small holes and sometimes two handles.", "Unlike a pot, it lets water run out."],
  looks: "It looks like a bowl with many small holes.",
  use: "You put pasta inside. The water goes out, but the pasta stays.",
  phrases: ["It looks like...", "You use it when...", "It has...", "You put ... inside."],
  ja: ["ざる", "水切りざる"], ...over,
});
const word = (over: Record<string, unknown> = {}) => {
  const c = coerceWord(raw(over));
  if (!("word" in c)) throw new Error(c.errors.join());
  return c.word;
};

describe("vocabulary data for pair work", () => {
  it("keeps Giver notes and approved Japanese answers (flat or nested, as the AI may send them)", () => {
    const flat = word();
    expect(flat.giverInfo).toEqual({ looks: "It looks like a bowl with many small holes.", use: "You put pasta inside. The water goes out, but the pasta stays.", phrases: ["It looks like...", "You use it when...", "It has...", "You put ... inside."] });
    expect(flat.ja).toEqual(["ざる", "水切りざる"]);
    const nested = word({ looks: undefined, use: undefined, phrases: undefined, giverInfo: { use: "You drain pasta." }, japanese: undefined });
    expect(nested.giverInfo).toEqual({ use: "You drain pasta." });
  });
  it("older words (no notes, no Japanese) are still valid and simply lack the fields", () => {
    const old = word({ looks: undefined, use: undefined, phrases: undefined, ja: undefined });
    expect(old.giverInfo).toBeUndefined();
    expect(old.ja).toBeUndefined();
    expect(validateWord(old).some((i) => i.severity === "error")).toBe(false);
  });
  it("cleans and limits Japanese answers and notes", () => {
    expect(coerceJa(["ざる", "ザル", " 水切り ざる ", "", 5, "ざる"])).toEqual(["ざる", "水切り ざる"]);
    expect(coerceJa("ざる、水切りざる, ザル")).toEqual(["ざる", "水切りざる"]);
    expect(coerceJa(Array.from({ length: 20 }, (_, i) => `あ${"い".repeat(i + 1)}`))).toHaveLength(8);
    expect(coerceJa("x".repeat(100))[0]).toHaveLength(40);
    expect(coerceJa(undefined)).toEqual([]);
    const long = word({ phrases: ["a", "b", "c", "d", "e", "f"], looks: "x".repeat(500) });
    expect(long.giverInfo!.phrases).toHaveLength(4);
    expect(long.giverInfo!.looks!.length).toBe(200);
  });
  it("tells the teacher what is missing, without blocking (warnings, not errors)", () => {
    const none = word({ looks: undefined, use: undefined, phrases: undefined, ja: undefined });
    const codes = validateWord(none).map((i) => i.code);
    expect(codes).toContain("no-japanese");
    expect(codes).toContain("no-giver-info");
    expect(validateWord(none).filter((i) => i.code === "no-japanese" || i.code === "no-giver-info").every((i) => i.severity === "warning")).toBe(true);
    expect(validateWord(word()).filter((i) => i.severity === "error")).toEqual([]);
    expect(validateWord(word()).map((i) => i.code)).not.toContain("no-japanese");
  });
  it("warns when Giver notes contain the word the Giver may not say", () => {
    const issues = validateWord(word({ use: "You drain pasta in a colander." }));
    expect(issues.some((i) => i.field === "giverInfo" && /target word/.test(i.message))).toBe(true);
  });
  it("warns about duplicate Japanese answers that differ only in kana type", () => {
    const w = { ...word(), ja: ["ざる", "ザル"] };
    expect(validateWord(w).some((i) => i.field === "ja")).toBe(true);
  });
});

describe("the opening hint must be a real situation", () => {
  it("flags generic labels and accepts a scene", () => {
    for (const vague of ["It's a kitchen tool.", "It is a thing.", "It is used in the kitchen.", "It is used for cooking.", "It belongs to the topic “Kitchen tools”."]) {
      expect(isVagueOpeningHint(vague), vague).toBe(true);
    }
    for (const good of ["You often need this after boiling pasta or washing vegetables.", "You open this when the rain starts to fall."]) {
      expect(isVagueOpeningHint(good), good).toBe(false);
    }
  });
  it("shows a warning in the editor for a vague hint 1", () => {
    const issues = validateWord(word({ hints: ["It is a kitchen tool.", "It has many small holes and sometimes two handles.", "Unlike a pot, it lets water run out."] }));
    expect(issues.find((i) => i.code === "vague-opening")).toMatchObject({ severity: "warning", hintIndex: 0 });
  });
  it("AI output with a vague opening hint is rejected (so the teacher never sees it)", () => {
    const parsed = parseGeneratedWords([raw({ hints: ["It's a kitchen tool.", "It has many small holes and handles.", "Unlike a pot, it lets water run out."] }), raw({ word: "whisk" , ja: ["泡立て器"], hints: ["You use this to beat eggs for an omelette.", "It has thin wires joined at the handle.", "It makes cream light and fluffy."], looks: "It has thin wires.", use: "You move it fast.", phrases: ["It has..."] })]);
    expect(parsed.words.map((w) => w.word)).toEqual(["whisk"]);
    expect(parsed.issues.join(" ")).toMatch(/real situation/);
  });
  it("accepts a good AI item with Japanese answers and Giver notes", () => {
    const parsed = parseGeneratedWords([raw()]);
    expect(parsed.words).toHaveLength(1);
    expect(parsed.words[0].ja).toEqual(["ざる", "水切りざる"]);
  });
});

describe("AI generation instructions (no per-round AI call is involved)", () => {
  const system = () => generatePrompt({ ...EMPTY_BRIEF, topic: "kitchen tools" }, 10, [])[0].content;
  it("asks for an opening hint that is a situation, free, and shown to both players", () => {
    const r = system();
    expect(r).toMatch(/hint 1 = the OPENING HINT/);
    expect(r).toMatch(/FREE/);
    expect(r).toMatch(/after boiling pasta or washing vegetables/);
  });
  it("asks for Giver notes adapted to the kind of word, in speakable English easier than the target", () => {
    const r = system();
    expect(r).toMatch(/"looks", "use", "phrases"/);
    expect(r).toMatch(/It looks like a bowl with many small holes/);
    expect(r).toMatch(/actions: .*what you would SEE/);
    expect(r).toMatch(/Emotions \/ abstract words \/ expressions: leave "looks" as an empty string/);
    expect(r).toMatch(/EASIER than the target word/);
    expect(r).toMatch(/Do not use the target word/);
  });
  it("asks for approved Japanese equivalents on every item, never merely related words", () => {
    const r = system();
    expect(r).toMatch(/"ja": 1 to 6 approved JAPANESE EQUIVALENTS/);
    expect(r).toMatch(/\["ざる", "水切りざる"/);
    expect(r).toMatch(/never merely related words/);
    expect(r).toMatch(/EVERY item needs this field/);
    expect(r).toMatch(/Use an empty array ONLY when the target truly has no Japanese equivalent/);
  });
  it("the item shape includes the new fields", () => {
    expect(JSON.stringify(generatePrompt(EMPTY_BRIEF, 3, []))).toContain('\\"ja\\": string[]');
  });
  it("regenerating hints reuses the same rules, so a new hint 1 is again an opening situation", () => {
    expect(hintsPrompt(EMPTY_BRIEF, word())[0].content).toMatch(/OPENING HINT/);
  });
});

describe("compatibility with requests, saved activities and the sample set", () => {
  it("replace-word / regenerate-hints requests carry the Japanese answers and notes through", () => {
    const req = parseStudioRequest({ task: "regenerate-hints", brief: EMPTY_BRIEF, word: { ...word(), id: "w1" } });
    if (req.task !== "regenerate-hints") throw new Error();
    expect(req.word.ja).toEqual(["ざる", "水切りざる"]);
    expect(req.word.giverInfo?.use).toMatch(/pasta/);
  });
  it("saved activities round-trip the new fields, and activities saved before them still load", () => {
    const mem = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
    const mk = (words: unknown[]): Activity => ({
      id: "a1", title: "T", brief: EMPTY_BRIEF, messages: [], createdAt: "x", updatedAt: "x", version: 1,
      sets: [{ id: "s1", title: "S", status: "approved", words: words as never, lockedIds: [] }],
    });
    expect(saveActivity(storage, mk([word()])).ok).toBe(true);
    const back = loadActivities(storage).activities[0].sets[0].words[0];
    expect(back.ja).toEqual(["ざる", "水切りざる"]);
    expect(back.giverInfo?.phrases).toHaveLength(4);
    // a v1 activity written before the feature existed
    const { ja: _j, giverInfo: _g, ...legacy } = word();
    void _j; void _g;
    mem.set(STORAGE_KEY, JSON.stringify([mk([legacy])]));
    const old = loadActivities(storage);
    expect(old.skipped).toBe(0);
    expect(old.activities[0].sets[0].words[0]).toMatchObject({ word: "colander" });
    expect(old.activities[0].sets[0].words[0].ja).toBeUndefined();
  });
  it("every word of the built-in sample set is valid, has an opening situation, Giver notes and Japanese answers", () => {
    expect(SAMPLE_SET.words).toHaveLength(10);
    for (const w of SAMPLE_SET.words) {
      expect(validateWord(w).filter((i) => i.severity === "error"), w.word).toEqual([]);
      expect(isVagueOpeningHint(w.hints[0]), w.word).toBe(false);
      expect(w.hints.some((h) => leaksTarget(w, h)), w.word).toBe(false);
      expect(w.giverInfo?.use, w.word).toBeTruthy();
      expect((w.giverInfo?.phrases ?? []).length, w.word).toBeGreaterThanOrEqual(3);
      expect((w.ja ?? []).length, w.word).toBeGreaterThanOrEqual(2);
      for (const line of [w.giverInfo?.looks, w.giverInfo?.use, ...(w.giverInfo?.phrases ?? [])]) {
        if (line) {
          expect(leaksTarget(w, line), `${w.word}: ${line}`).toBe(false);
          expect(line.split(/\s+/).length, `${w.word}: ${line}`).toBeLessThanOrEqual(25);
        }
      }
    }
  });
});

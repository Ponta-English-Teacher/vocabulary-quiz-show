import { describe, expect, it, vi } from "vitest";
import { CEFR_LEVELS } from "@/data/vocab";
import { EMPTY_BRIEF, type Brief } from "./types";
import { approvedPrompt, chatPrompt, generatePrompt, replacePrompt } from "./ai/prompts";
import { mockGenerate, mockReplace } from "./ai/mock";
import { handleStudioRequest } from "./ai/service";
import { levelMix, mixAdvice } from "./ops";
import { coerceWord, parseGeneratedWords, validateWord } from "./validation";
import type { VocabWord } from "@/data/vocab";

const brief = (over: Partial<Brief> = {}): Brief => ({ ...EMPTY_BRIEF, topic: "Kitchen tools", level: "B2", ...over });
const seeded = () => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };
const item = (word: string, cefr: string) => ({
  word, accept: [], partOfSpeech: "noun", cefr, category: "Kitchen tools", meaning: `a thing for ${word.length} jobs`, example: `Pass me the ${word}, please.`,
  hints: [`You would grab this on a busy evening, number ${word.length}.`, "It lives in a drawer and has a distinctive shape.", `Unlike a bowl, a ____ is made for one particular job (${word.length}).`],
});
const reply = (payload: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
const deps = (f: ReturnType<typeof vi.fn>) => ({ apiKey: "fake-key-for-tests", model: "test-model", fetchImpl: f as never });
const MIXED = [["knife", "A1"], ["spoon", "A1"], ["pan", "A2"], ["peeler", "B1"], ["whisk", "B1"], ["colander", "B2"], ["ladle", "B2"], ["zester", "C1"], ["mandoline", "C1"], ["chinois", "C2"]] as const;

describe("level = overall communication difficulty, not a per-word filter", () => {
  const all = () => [
    chatPrompt([{ role: "teacher", text: "hi" }], brief())[0].content,
    generatePrompt(brief(), 10, [])[0].content,
    approvedPrompt(brief(), ["whisk"])[0].content,
    replacePrompt(brief(), { id: "x", ...item("whisk", "B1") } as unknown as VocabWord, [])[0].content,
  ];

  it("every prompt states the principle: overall communication, a mixture, familiar words on purpose, variation is a feature", () => {
    for (const p of all()) {
      expect(p).toMatch(/OVERALL communication difficulty/);
      expect(p).toMatch(/NOT the required level of every word/);
      expect(p).toMatch(/MIXTURE: familiar words, moderately challenging words and some unfamiliar ones/);
      expect(p).toMatch(/Include familiar words on purpose, even in advanced activities/);
      expect(p).toMatch(/Difficulty variation is a feature/);
      expect(p).toMatch(/do NOT replace, reject or "correct" a word because its CEFR label differs from the activity level/i);
      expect(p).toMatch(/Judge a set by how well it supports interactive communication/);
    }
  });
  it("covers the communication skills that matter: explaining, asking, negotiating, helping the partner", () => {
    expect(all()[0]).toMatch(/explain a word with language they already know, ask questions, negotiate meaning, and help their partner/);
    expect(all()[0]).toMatch(/Hints, definitions and examples should use language easier than the target word/);
  });
  it("labels are descriptive, and the old restrictive wording is gone", () => {
    for (const p of all()) {
      expect(p).toMatch(/DESCRIPTIVE label of its honest difficulty, never a rule/);
      expect(p).not.toMatch(/choose words that truly sit at that level/i);
      expect(p).not.toMatch(/one level either side only/i);
    }
  });
  it("the chat AI is told to suggest a deliberate mix and never swap words just for their CEFR label", () => {
    const sys = all()[0];
    expect(sys).toMatch(/show a deliberate mix of familiar, moderately challenging and unfamiliar words/);
    expect(sys).toMatch(/Never remove or swap a word merely because its CEFR label differs from the activity level/);
    expect(sys).toMatch(/how demanding the conversation should be, NOT a limit on each word's level/);
  });
  it("replacing one word keeps the set's mix: the replacement need not match the activity level", () => {
    const user = replacePrompt(brief(), { id: "x", ...item("whisk", "B1") } as unknown as VocabWord, [])[1].content;
    expect(user).toMatch(/the replacement need not match the activity level/);
    expect(user).toMatch(/Keep the set's mix of familiar and challenging words/);
  });
  it("the hint-quality rules are still there", () => {
    const r = all()[1];
    expect(r).toMatch(/PROGRESS — each strictly more informative/);
    expect(r).toMatch(/NEVER write a hint that is just "The first letter is x"/);
    expect(r).toMatch(/Do not reuse the same hint pattern/);
  });

  it("real-AI path: a B2 activity with words from A1 to C2 is accepted as is — nothing rejected or relabelled", async () => {
    const f = vi.fn(async () => reply({ words: MIXED.map(([w, c]) => item(w, c)) }));
    const r = await handleStudioRequest({ task: "generate", brief: brief({ level: "B2" }), count: 10, exclude: [] }, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("failed");
    expect(r.body.data.words).toHaveLength(10);
    expect(r.body.data.issues).toEqual([]);
    expect(r.body.data.words.map((w) => [w.word, w.cefr])).toEqual(MIXED.map(([w, c]) => [w, c]));
    expect(f).toHaveBeenCalledTimes(1); // no "level correction" retry
  });
  it("teacher-approved words are never overridden, however far from the activity level", async () => {
    const approved = ["knife", "chinois", "pan"];
    const f = vi.fn(async () => reply({ words: [item("knife", "A1"), item("chinois", "C2"), item("pan", "A2")] }));
    const r = await handleStudioRequest({ task: "generate", brief: brief({ level: "B1" }), count: 3, exclude: [], approved }, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("failed");
    expect(r.body.data.words.map((w) => [w.word, w.cefr])).toEqual([["knife", "A1"], ["chinois", "C2"], ["pan", "A2"]]);
    expect(r.body.data.issues).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("validation has no opinion about a word's level relative to the activity", () => {
    for (const lvl of CEFR_LEVELS) {
      const c = coerceWord(item("whisk", lvl));
      if (!("word" in c)) throw new Error();
      expect(validateWord(c.word).filter((i) => i.field === "cefr")).toEqual([]);
    }
    const parsed = parseGeneratedWords(MIXED.map(([w, c]) => item(w, c)));
    expect(parsed.words).toHaveLength(10);
  });

  it("mock generation produces a mixture whatever the activity level", () => {
    for (const level of ["A1", "B2", "C2"] as const) {
      const words = mockGenerate(brief({ topic: "Everyday physical actions", level }), 10, [], seeded());
      const levels = new Set(words.map((w) => w.cefr));
      expect(levels.size, `level ${level}`).toBeGreaterThanOrEqual(3);
      expect(words.some((w) => ["A2", "B1"].includes(w.cefr)), `familiar words at ${level}`).toBe(true);
      expect(words.some((w) => w.cefr === "C1"), `challenging words at ${level}`).toBe(true);
    }
  });
  it("mock 'mostly less common' leans challenging but keeps familiar anchors", () => {
    const words = mockGenerate(brief({ topic: "Less common fruits", level: "B2", balance: "Mostly less common words" }), 8, [], seeded());
    expect(words.length).toBe(8);
    expect(new Set(words.map((w) => w.cefr)).size).toBeGreaterThan(1);
  });
  it("mock replace keeps the replaced word's difficulty, not the activity level", () => {
    const pool = mockGenerate(brief({ topic: "Everyday physical actions", level: "B2" }), 10, [], seeded());
    const challenging = pool.find((w) => w.cefr === "C1")!;
    const familiar = pool.find((w) => w.cefr === "A2" || w.cefr === "B1")!;
    // the activity level (A1) is irrelevant: a C1 word is replaced by another C1 word, a familiar one by a familiar one
    const nextC = mockReplace(brief({ topic: "Everyday physical actions", level: "A1" }), challenging, [], seeded());
    expect(nextC.cefr).toBe("C1");
    expect(nextC.word).not.toBe(challenging.word);
    const nextF = mockReplace(brief({ topic: "Everyday physical actions", level: "C2" }), familiar, [], seeded());
    expect(["A2", "B1"]).toContain(nextF.cefr);
  });

  it("summarises the mix descriptively (never as pass/fail)", () => {
    const words = MIXED.map(([w, c]) => coerceWord(item(w, c))).map((c) => ("word" in c ? c.word : null)!) as VocabWord[];
    expect(levelMix(words)).toEqual({ familiar: 3, moderate: 4, challenging: 3 });
    expect(mixAdvice(words)).toBeNull();
  });
  it("gives gentle communication advice for sets with no familiar words, or only familiar ones", () => {
    const mk = (c: string) => Array.from({ length: 6 }, (_, i) => ("word" in coerceWord(item(`w${i}x`, c)) ? (coerceWord(item(`w${i}x`, c)) as { word: VocabWord }).word : null)!) as VocabWord[];
    expect(mixAdvice(mk("C1"))).toMatch(/No familiar words/);
    expect(mixAdvice(mk("A1"))).toMatch(/Every word here is familiar/);
    expect(mixAdvice(mk("A1").slice(0, 3))).toBeNull();
  });
});

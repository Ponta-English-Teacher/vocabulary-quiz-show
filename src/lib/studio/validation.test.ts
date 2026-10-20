import { describe, expect, it } from "vitest";
import type { VocabWord } from "@/data/vocab";
import { coerceWord, leaksTarget, parseGeneratedWords, validateWord } from "./validation";

const raw = (over: Record<string, unknown> = {}) => ({
  word: "umbrella", accept: ["umbrellas"], partOfSpeech: "noun", cefr: "a2", category: "Everyday objects",
  meaning: "Something you hold over your head when it rains.", example: "Take an umbrella.",
  hints: ["You see many of these outside a train station when it pours.", "It folds up small and has a long handle.", "People hold it above their heads to stay dry in the rain."], ...over,
});
const good = (over: Record<string, unknown> = {}): VocabWord => {
  const c = coerceWord(raw(over));
  if (!("word" in c)) throw new Error(c.errors.join());
  return c.word;
};

describe("leaksTarget", () => {
  const t = { word: "umbrella", accept: ["umbrellas"] };
  it("catches the word, inflections and case changes", () => {
    expect(leaksTarget(t, "You open an Umbrella!")).toBe(true);
    expect(leaksTarget(t, "two umbrellas")).toBe(true);
    expect(leaksTarget(t, "It keeps off the rain.")).toBe(false);
  });
  it("is careful with short words", () => {
    const fig = { word: "fig" };
    expect(leaksTarget(fig, "a figure skater")).toBe(false);
    expect(leaksTarget(fig, "dried figs")).toBe(true);
  });
  it("catches the whole phrase or a long content word of an expression", () => {
    const p = { word: "figure out", accept: [] };
    expect(leaksTarget(p, "I finally figured it out")).toBe(true); // "figure" stem
    expect(leaksTarget(p, "to solve a puzzle")).toBe(false);
    expect(leaksTarget({ word: "by the way" }, "Say by the way first")).toBe(true);
  });
});

describe("coerceWord", () => {
  it("normalises a well-formed AI item", () => {
    const w = good();
    expect(w).toMatchObject({ word: "umbrella", cefr: "A2", partOfSpeech: "noun", accept: ["umbrellas"] });
    expect(w.hints).toHaveLength(3);
    expect(w.id).not.toContain("umbrella"); // opaque id
  });
  it("maps part-of-speech aliases and trims extra hints", () => {
    const w = good({ partOfSpeech: "Idiom", hints: ["a", "b", "c", "d"] });
    expect(w.partOfSpeech).toBe("phrase");
    expect(w.hints).toEqual(["a", "b", "c"]);
  });
  it("rejects malformed items with reasons", () => {
    for (const bad of [null, "str", [], raw({ word: "" }), raw({ cefr: "Z9" }), raw({ hints: ["only one"] }), raw({ meaning: undefined })]) {
      expect("errors" in coerceWord(bad)).toBe(true);
    }
  });
  it("drops accepted answers equal to the word or duplicated", () => {
    expect(good({ accept: ["Umbrella", "brolly", "brolly"] }).accept).toEqual(["brolly"]);
  });
});

describe("validateWord", () => {
  it("passes a good word", () => expect(validateWord(good())).toEqual([]));
  it("flags hints that reveal the word (error) and category leaks", () => {
    const issues = validateWord(good({ hints: ["Open your umbrella", "b", "c"], category: "Umbrella things" }));
    expect(issues.filter((i) => i.severity === "error").map((i) => i.field).sort()).toEqual(["category", "hints"]);
  });
  it("only warns when the definition contains the word", () => {
    const issues = validateWord(good({ meaning: "An umbrella keeps you dry." }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
  });
  it("requires exactly three non-empty hints", () => {
    const w = { ...good(), hints: ["a", "", "c"] };
    expect(validateWord(w).some((i) => i.severity === "error" && i.hintIndex === 1)).toBe(true);
    expect(validateWord({ ...good(), hints: ["a", "b"] }).some((i) => i.severity === "error")).toBe(true);
  });
});

describe("parseGeneratedWords", () => {
  it("keeps valid items, rejects leaky/malformed/duplicate ones, and explains why", () => {
    const list = [
      raw({ word: "apple", hints: ["h1", "h2", "h3"], accept: [], meaning: "m", example: "e", category: "Fruit" }),
      raw({ word: "banana", hints: ["a banana!", "h2", "h3"], accept: [] }), // leak
      { word: "nope" }, // malformed
      raw({ word: "Apple", hints: ["x1", "x2", "x3"], accept: [] }), // duplicate
      raw({ word: "cherry", hints: ["p", "q", "r"], accept: [] }),
    ];
    const { words, issues } = parseGeneratedWords(list);
    expect(words.map((w) => w.word)).toEqual(["apple", "cherry"]);
    expect(issues).toHaveLength(3);
    expect(issues.join(" ")).toMatch(/gives away/);
    expect(issues.join(" ")).toMatch(/duplicate/);
  });
  it("avoids excluded words and respects max", () => {
    const list = ["a1", "b1", "c1", "d1"].map((w) => raw({ word: w, hints: ["x", "y", "z"], accept: [], category: "Misc" }));
    const { words } = parseGeneratedWords(list, { exclude: ["B1"], max: 2 });
    expect(words.map((w) => w.word)).toEqual(["a1", "c1"]);
  });
  it("handles non-array input safely", () => {
    expect(parseGeneratedWords({ words: [] }).words).toEqual([]);
    expect(parseGeneratedWords(undefined).issues).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { giverNotesFor } from "./giverNotes";

const word = (over: Partial<VocabWord>): VocabWord => ({ ...SAMPLE_SET.words[0], ...over });

describe("giverNotesFor", () => {
  it("uses the word's own appearance, use and phrases", () => {
    const n = giverNotesFor(SAMPLE_SET.words[0]);
    expect(n.custom).toBe(true);
    expect(n.looks).toMatch(/handle/);
    expect(n.use).toMatch(/rain/);
    expect(n.phrases).toContain("You use it when...");
  });
  it("adapts the headings to the kind of word instead of forcing an object template", () => {
    expect(giverNotesFor(word({ partOfSpeech: "noun" })).looksLabel).toBe("What it looks like");
    expect(giverNotesFor(word({ partOfSpeech: "verb" })).looksLabel).toBe("What you would see");
    expect(giverNotesFor(word({ partOfSpeech: "adjective" })).useLabel).toBe("When you feel or say it");
    expect(giverNotesFor(word({ partOfSpeech: "phrase" })).useLabel).toBe("When people say it");
  });
  it("leaves out appearance for abstract words that have none", () => {
    const deadline = SAMPLE_SET.words.find((w) => w.word === "deadline")!;
    const n = giverNotesFor(deadline);
    expect(n.looks).toBeNull();
    expect(n.use).toBeTruthy();
  });
  it("older words without notes still get generic, part-of-speech starters", () => {
    const old = word({ giverInfo: undefined, partOfSpeech: "verb" });
    const n = giverNotesFor(old);
    expect(n.custom).toBe(false);
    expect(n.looks).toBeNull();
    expect(n.use).toBeNull();
    expect(n.phrases.length).toBeGreaterThanOrEqual(3);
    expect(n.phrases[0]).toMatch(/do/);
  });
});

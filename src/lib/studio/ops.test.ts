import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import {
  activityFromSample, addSet, approvalProblems, approveSet, createActivity, createSet, regenerateSet,
  removeSet, replaceWord, setHints, toggleLock, toVocabSet, updateWord,
} from "./ops";
import type { Activity } from "./types";

const mk = (word: string): VocabWord => ({
  id: `id-${word}`, word, partOfSpeech: "noun", cefr: "A2", category: "Test", meaning: `meaning of ${word}`,
  example: `Use ${word} here.`, hints: [`${word.length} letters? no`, "second hint", "third hint"],
});
const names = ["ant", "bee", "cat", "dog", "eel", "fox", "gnu", "hen", "ibis", "jay"];
function fixture(): { a: Activity; setId: string } {
  const set = createSet(names.map(mk), "Set 1");
  return { a: { ...createActivity("Test"), sets: [set] }, setId: set.id };
}

describe("editing one word", () => {
  it("updates only the chosen word and leaves others identical (same objects)", () => {
    const { a, setId } = fixture();
    const next = updateWord(a, setId, "id-cat", { meaning: "a small pet", example: "The cat sleeps." });
    const before = a.sets[0].words, after = next.sets[0].words;
    expect(after[2].meaning).toBe("a small pet");
    after.forEach((w, i) => { if (i !== 2) expect(w).toBe(before[i]); });
    expect(a.sets[0].words[2].meaning).toBe("meaning of cat"); // original not mutated
  });
  it("ignores unknown set ids", () => {
    const { a } = fixture();
    expect(updateWord(a, "nope", "id-cat", { meaning: "x" })).toBe(a);
  });
});

describe("replacing one word", () => {
  it("swaps exactly that slot, keeps position, gives a new opaque id, others untouched", () => {
    const { a, setId } = fixture();
    const { activity, error } = replaceWord(a, setId, "id-dog", mk("wolf"));
    expect(error).toBeUndefined();
    const words = activity.sets[0].words;
    expect(words[3].word).toBe("wolf");
    expect(words[3].id).not.toBe("id-dog");
    words.forEach((w, i) => { if (i !== 3) expect(w).toBe(a.sets[0].words[i]); });
  });
  it("refuses a duplicate of another word in the set", () => {
    const { a, setId } = fixture();
    const r = replaceWord(a, setId, "id-dog", mk("Cat"));
    expect(r.error).toMatch(/already/);
    expect(r.activity).toBe(a);
  });
  it("removes a lock from the replaced word", () => {
    const { a, setId } = fixture();
    const locked = toggleLock(a, setId, "id-dog");
    expect(locked.sets[0].lockedIds).toEqual(["id-dog"]);
    expect(replaceWord(locked, setId, "id-dog", mk("wolf")).activity.sets[0].lockedIds).toEqual([]);
  });
});

describe("regenerating hints", () => {
  it("changes only that word's hints — word, meaning and every other word stay", () => {
    const { a, setId } = fixture();
    const next = setHints(a, setId, "id-fox", ["new 1", "new 2", "new 3"]);
    const w = next.sets[0].words[5];
    expect(w.hints).toEqual(["new 1", "new 2", "new 3"]);
    expect(w.word).toBe("fox");
    expect(w.meaning).toBe(a.sets[0].words[5].meaning);
    next.sets[0].words.forEach((x, i) => { if (i !== 5) expect(x).toBe(a.sets[0].words[i]); });
  });
});

describe("regenerating a whole set", () => {
  it("keeps locked words in place and replaces the rest, skipping duplicates of locked ones", () => {
    const { a, setId } = fixture();
    let cur = toggleLock(a, setId, "id-ant");
    cur = toggleLock(cur, setId, "id-jay");
    const fresh = ["ant", "lion", "tiger", "bear", "wolf", "lynx", "puma", "otter", "seal", "mole"].map(mk);
    const { activity, replaced } = regenerateSet(cur, setId, fresh);
    const words = activity.sets[0].words;
    expect(words).toHaveLength(10);
    expect(words[0]).toBe(cur.sets[0].words[0]); // locked ant untouched
    expect(words[9]).toBe(cur.sets[0].words[9]); // locked jay untouched
    expect(words.filter((w) => w.word === "ant")).toHaveLength(1); // fresh "ant" skipped
    expect(replaced).toBe(8);
    expect(words.slice(1, 9).map((w) => w.word)).toEqual(["lion", "tiger", "bear", "wolf", "lynx", "puma", "otter", "seal"]);
  });
  it("keeps old words when the AI supplies too few", () => {
    const { a, setId } = fixture();
    const { activity, replaced } = regenerateSet(a, setId, [mk("lion"), mk("bear")]);
    expect(replaced).toBe(2);
    expect(activity.sets[0].words.map((w) => w.word).slice(2)).toEqual(names.slice(2));
  });
});

describe("approval", () => {
  it("approves a valid ten-word set and sends it back to draft after any edit", () => {
    const { a, setId } = fixture();
    const { activity, problems } = approveSet(a, setId);
    expect(problems).toEqual([]);
    expect(activity.sets[0].status).toBe("approved");
    expect(updateWord(activity, setId, "id-cat", { meaning: "changed" }).sets[0].status).toBe("draft");
  });
  it("blocks approval for wrong size, leaks, and duplicates", () => {
    const { a, setId } = fixture();
    expect(approvalProblems({ ...a.sets[0], words: [] })[0]).toMatch(/1 to 10 words/);
    expect(approvalProblems({ ...a.sets[0], words: [...a.sets[0].words, ...a.sets[0].words.slice(0, 1)] }).join()).toMatch(/1 to 10 words/);
    expect(approvalProblems({ ...a.sets[0], words: a.sets[0].words.slice(0, 9) })).toEqual([]); // a smaller set is fine
    const leaky = updateWord(a, setId, "id-cat", { hints: ["a cat!", "b", "c"] });
    expect(approveSet(leaky, setId).problems.join()).toMatch(/gives away/);
    expect(approveSet(leaky, setId).activity).toBe(leaky);
    const dup = updateWord(a, setId, "id-dog", { word: "cat" });
    expect(approvalProblems(dup.sets[0]).join()).toMatch(/duplicate/);
  });
});

describe("sets", () => {
  it("adds and removes sets", () => {
    const { a, setId } = fixture();
    const two = addSet(a, names.map((n) => mk(`${n}x`)));
    expect(two.sets.map((s) => s.title)).toEqual(["Set 1", "Set 2"]);
    expect(removeSet(two, setId).sets).toHaveLength(1);
  });
  it("creates an editable, approved copy of the built-in sample with fresh opaque ids", () => {
    const a = activityFromSample();
    expect(a.sets[0].words.map((w) => w.word)).toEqual(SAMPLE_SET.words.map((w) => w.word));
    expect(a.sets[0].status).toBe("approved");
    expect(a.sets[0].words[0].id).not.toBe(SAMPLE_SET.words[0].id);
  });
  it("converts to a game-ready VocabSet with the actual approved words", () => {
    const { a, setId } = fixture();
    const vs = toVocabSet(a, a.sets[0]);
    expect(vs.id).toBe(setId);
    expect(vs.words).toBe(a.sets[0].words);
  });
});

describe("topping up a short set", () => {
  it("appends only new words up to ten and leaves existing words untouched", async () => {
    const { appendWords } = await import("./ops");
    const set = createSet(names.slice(0, 8).map(mk), "Set 1");
    const a = { ...createActivity("T"), sets: [set] };
    const next = appendWords(a, set.id, [mk("cat"), mk("kiwi"), mk("lark"), mk("mole")]);
    expect(next.sets[0].words.map((w) => w.word)).toEqual([...names.slice(0, 8), "kiwi", "lark"]);
    next.sets[0].words.slice(0, 8).forEach((w, i) => expect(w).toBe(set.words[i]));
  });
});

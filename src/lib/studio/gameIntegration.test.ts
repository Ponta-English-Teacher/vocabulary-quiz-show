import { describe, expect, it } from "vitest";
import { createInitialState, currentWord, gameReducer, redactForTaker, type GameAction, type GameState } from "@/lib/game";
import { checkAnswer } from "@/lib/answer";
import { createActivity, createSet, approveSet, toVocabSet } from "./ops";
import { coerceWord } from "./validation";
import type { VocabWord } from "@/data/vocab";

const make = (word: string, accept: string[], over: Partial<VocabWord> = {}): VocabWord => {
  const c = coerceWord({
    word, accept, partOfSpeech: "noun", cefr: "B1", category: "Teacher topic", meaning: `Definition for ${word.length}-letter item`,
    example: "Example sentence.", hints: [`first clue ${word.length}`, "second clue", "third clue"], ...over,
  });
  if (!("word" in c)) throw new Error(c.errors.join());
  return c.word;
};
const WORDS: [string, string[]][] = [
  ["pomegranate", ["pomegranates"]], ["persimmon", []], ["fig", ["figs"]], ["apricot", []], ["plum", []],
  ["lychee", ["litchi"]], ["papaya", []], ["guava", []], ["cranberry", ["cranberries"]], ["take a break", ["have a break"]],
];
function approvedSet() {
  let a = createActivity("Fruit & expressions");
  const set = createSet(WORDS.map(([w, acc]) => make(w, acc)), "Set 1");
  a = { ...a, sets: [set], brief: { ...a.brief, topic: "Mixed" } };
  const r = approveSet(a, set.id);
  expect(r.problems).toEqual([]);
  return { a: r.activity, vocab: toVocabSet(r.activity, r.activity.sets[0]) };
}
const run = (actions: GameAction[], from: GameState) => actions.reduce(gameReducer, from);

describe("teacher-approved set → game", () => {
  it("the game uses exactly the approved words, hints and accepted answers", () => {
    const { vocab } = approvedSet();
    const s = run([{ type: "START", names: ["Aki", "Ben"], words: vocab.words }], createInitialState());
    expect(s.words).toBe(vocab.words);
    expect(s.words.map((w) => w.word)).toEqual(WORDS.map(([w]) => w));
    expect(Object.keys(s.statuses)).toHaveLength(10);
  });
  it("recognises the word, accepted alternatives and dictation-style replies; rejects others", () => {
    const { vocab } = approvedSet();
    const lychee = vocab.words.find((w) => w.word === "lychee")!;
    expect(checkAnswer("Lychee", lychee)).toBe("correct");
    expect(checkAnswer("litchi", lychee)).toBe("correct");
    expect(checkAnswer("it's a lychee", lychee)).toBe("correct");
    expect(checkAnswer("lichee", lychee)).toBe("close");
    expect(checkAnswer("mango", lychee)).toBe("wrong");
    const phrase = vocab.words.find((w) => w.word === "take a break")!;
    expect(checkAnswer("have a break", phrase)).toBe("correct");
  });
  it("plays a round with an alternative answer and scores it by the existing rules", () => {
    const { vocab } = approvedSet();
    let s = run([{ type: "START", names: ["Aki", "Ben"], words: vocab.words }, { type: "CONTINUE" }], createInitialState());
    const target = vocab.words[5]; // lychee
    s = run([{ type: "PICK", wordId: target.id }, { type: "REVEAL_HINT" }, { type: "GUESS", text: "litchi" }], s);
    expect(s.phase).toBe("reveal");
    expect(s.lastResult).toMatchObject({ outcome: "solved", hintsUsed: 1, takerPoints: 85, giverPoints: 43 });
    expect(currentWord(s)?.word).toBe("lychee");
  });
  it("never leaks any teacher word, definition, example, hint or accepted answer to the Taker", () => {
    const { vocab } = approvedSet();
    let s = run([{ type: "START", names: ["Aki", "Ben"], words: vocab.words }, { type: "CONTINUE" }], createInitialState());
    s = run([{ type: "PICK", wordId: vocab.words[5].id }, { type: "REVEAL_HINT" }], s);
    const json = JSON.stringify(redactForTaker(s)).toLowerCase();
    for (const w of vocab.words) {
      // The opening hint + the one revealed hint of the word in play are on screen (the fixture reuses hint texts across words).
      const showing = vocab.words[5].hints.slice(0, 2);
      for (const secret of [w.word, ...(w.accept ?? []), w.meaning, w.example, ...w.hints.filter((h) => !showing.includes(h))]) {
        expect(json, `leaked "${secret}"`).not.toContain(secret.toLowerCase());
      }
      expect(json).not.toContain(w.id.toLowerCase() + "-" + w.word); // ids are opaque
    }
    expect(redactForTaker(s).revealedHints).toBe(2); // counts are fine; only the revealed hints' text is shown
  });
  it("keeps the solved word visible to both after the round only", () => {
    const { vocab } = approvedSet();
    let s = run([{ type: "START", names: ["A", "B"], words: vocab.words }, { type: "CONTINUE" }, { type: "PICK", wordId: vocab.words[4].id }, { type: "GUESS", text: "plum" }], createInitialState());
    const view = redactForTaker(s);
    expect(view.words[4].word).toBe("plum");
    expect(view.words[0].word).toBe("");
  });
});

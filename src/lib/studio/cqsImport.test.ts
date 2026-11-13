import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkAnswer } from "@/lib/answer";
import { coerceWord, leaksTarget, validateWord } from "./validation";
import { approveSet, createActivity, createSet } from "./ops";
import { convertExport, convertQuestion, groupIntoSets, importedSourceIds, parseCqsExport, targetFromAnswer } from "./cqsImport";
import { loadActivities, saveActivity, type StorageLike } from "./storage";

const q = (over: Record<string, unknown> = {}) => ({
  id: "bank-a1-cat", cefrLevel: "A1", categoryId: "animals", categoryName: "Animals", prompt: "Which animal is this?",
  chunks: ["It can turn its ears to hear sounds behind it, and it sleeps about 15 hours a day.", "It likes to chase mice.", "It is a popular pet with whiskers and soft fur.", "It is a furry pet that says 'meow'."],
  choices: ["a dog", "a rabbit", "a cat", "a hamster"], correctIndex: 2, answer: "a cat", status: "approved", ...over,
});
const memory = (): StorageLike & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
};

describe("answer → target word", () => {
  it("drops a leading article but keeps the full answer accepted", () => {
    expect(targetFromAnswer("a cat")).toEqual({ word: "cat", accept: ["a cat"] });
    expect(targetFromAnswer("the Eiffel Tower")).toEqual({ word: "Eiffel Tower", accept: ["the Eiffel Tower"] });
    expect(targetFromAnswer("okra")).toEqual({ word: "okra", accept: [] });
    expect(targetFromAnswer("An apple")).toEqual({ word: "apple", accept: ["An apple"] });
  });
  it("a typed answer with or without the article is accepted by the game's own checker", () => {
    const item = convertQuestion(q());
    const w = item.word!;
    for (const g of ["cat", "a cat", "A CAT", "It's a cat."]) expect(checkAnswer(g, w)).toBe("correct");
    expect(checkAnswer("dog", w)).toBe("wrong");
  });
});

describe("one question", () => {
  it("converts level, category, answer and clues (easiest clue first, the hardest one unused)", () => {
    const item = convertQuestion(q());
    expect(item.status).toBe("ready");
    const w = item.word!;
    expect(w).toMatchObject({ word: "cat", cefr: "A1", category: "Animals", partOfSpeech: "noun", source: "classroom-quiz-show", sourceId: "bank-a1-cat" });
    expect(w.hints).toEqual(["It is a furry pet that says 'meow'.", "It is a popular pet with whiskers and soft fur.", "It likes to chase mice."]);
    expect(item.notes.join(" ")).toMatch(/hardest clue/);
  });
  it("never invents a definition, example sentence, Japanese or Giver notes", () => {
    const w = convertQuestion(q()).word!;
    expect(w.meaning).toBe("");
    expect(w.example).toBe("");
    expect(w.ja).toBeUndefined();
    expect(w.studyJa).toBeUndefined();
    expect(w.giverInfo).toBeUndefined();
  });
  it("leaves out a clue that contains the word and uses the others", () => {
    const item = convertQuestion(q({ answer: "a strawberry", choices: ["a pear", "a plum", "a strawberry", "a fig"], chunks: ["Its seeds are on the outside.", "A strawberry is red.", "It is a small red fruit.", "You can eat it with cream."] }));
    expect(item.status).toBe("ready");
    expect(item.word!.hints.every((h) => !leaksTarget(item.word!, h))).toBe(true);
    expect(item.word!.hints).not.toContain("A strawberry is red.");
    expect(item.notes.join(" ")).toMatch(/Clue 2 was left out/);
  });
  it("skips a question with fewer than three clean clues", () => {
    const item = convertQuestion(q({ chunks: ["Cats sleep a lot.", "A cat likes mice.", "The cat says meow.", "It is a furry pet that says 'meow'."] }));
    expect(item.status).toBe("skipped");
    expect(item.reasons.join(" ")).toMatch(/usable clue/);
    expect(item.word).toBeUndefined();
  });
  it("skips questions that are not approved, and malformed ones", () => {
    expect(convertQuestion(q({ status: "archived" })).status).toBe("skipped");
    expect(convertQuestion(q({ status: "needs_revision" })).reasons[0]).toMatch(/not approved/);
    expect(convertQuestion(q({ chunks: ["one", "two"] })).status).toBe("skipped");
    expect(convertQuestion(q({ cefrLevel: "Z9" })).status).toBe("skipped");
    expect(convertQuestion(null).status).toBe("skipped");
  });
  it("flags — never silently accepts — answers that are poor for spoken vocabulary", () => {
    const person = convertQuestion(q({ id: "p", prompt: "Who is this?", answer: "Franz Kafka", choices: ["a", "b", "Franz Kafka", "d"], chunks: ["He wrote stories in Prague.", "He worked in an office all day.", "His books are about strange worlds.", "He wrote a story about a man who turns into a bug."] }));
    expect(person.status).toBe("flagged");
    expect(person.word).toBeTruthy(); // flagged words are still convertible so the teacher can decide
    const accent = convertQuestion(q({ id: "a", prompt: "Which place is this?", answer: "Chichén Itzá", choices: ["a", "b", "Chichén Itzá", "d"], chunks: ["Ancient people built it long ago.", "It is a pyramid in a hot country.", "Many tourists visit it every year.", "It is in Mexico on the Yucatán peninsula."] }));
    expect(accent.status).toBe("flagged");
    expect(accent.reasons.join(" ")).toMatch(/accents/);
    const month = convertQuestion(q({ id: "m", prompt: "What month is this?", answer: "October", choices: ["a", "b", "October", "d"], chunks: ["It is the tenth month of the year.", "Children wear costumes at the end of it.", "Leaves turn red and yellow in this month.", "Halloween is on the last day of this month."] }));
    expect(month.status).toBe("ready");
  });
  it("every converted word passes the app's own word validation without errors", () => {
    const w = convertQuestion(q()).word!;
    expect(validateWord(w).filter((i) => i.severity === "error")).toEqual([]);
    expect(coerceWord(w, { id: w.id })).toHaveProperty("word"); // survives saving and loading
    expect(coerceWord({ ...w, source: undefined })).toHaveProperty("errors"); // ordinary words still need a definition and an example
  });
});

describe("a whole export", () => {
  it("rejects other formats and versions", () => {
    expect(parseCqsExport("nope")).toMatchObject({ ok: false });
    expect(parseCqsExport(JSON.stringify({ format: "other", version: 1, questions: [] }))).toMatchObject({ ok: false });
    expect(parseCqsExport(JSON.stringify({ format: "classroom-quiz-show/questions", version: 2, questions: [] }))).toMatchObject({ ok: false });
    expect(parseCqsExport(JSON.stringify({ format: "classroom-quiz-show/questions", version: 1, questions: [q()] }))).toMatchObject({ ok: true });
  });
  it("skips repeated words and questions imported before", () => {
    const r = convertExport([q(), q({ id: "dup" })]);
    expect(r.counts).toMatchObject({ total: 2, ready: 1, skipped: 1 });
    const again = convertExport([q()], new Set(["bank-a1-cat"]));
    expect(again.items[0]).toMatchObject({ status: "skipped" });
    expect(again.items[0].reasons[0]).toMatch(/Already imported/);
  });
  it("saving creates a NEW activity with approved sets and leaves existing activities untouched", () => {
    const storage = memory();
    const existing = createActivity("My own activity");
    saveActivity(storage, existing);
    const before = storage.data["vqs.activities.v1"];
    const words = [q(), q({ id: "x2", answer: "a dog", choices: ["a dog", "b", "c", "d"], correctIndex: 0, chunks: ["It barks at strangers.", "It likes long walks.", "It is a loyal pet that wags its tail.", "It is a pet that says 'woof'."] })].map((x) => convertQuestion(x).word!);
    let a = createActivity("Classroom Quiz Show import");
    a = { ...a, sets: groupIntoSets(words).map((s) => createSet(s.words, s.title)) };
    for (const s of a.sets) a = approveSet(a, s.id).activity;
    expect(a.sets.every((s) => s.status === "approved")).toBe(true);
    expect(saveActivity(storage, a).ok).toBe(true);
    const { activities } = loadActivities(storage);
    expect(activities.map((x) => x.id).sort()).toEqual([existing.id, a.id].sort());
    expect(activities.find((x) => x.id === existing.id)).toEqual(JSON.parse(before)[0]);
    const kept = activities.find((x) => x.id === a.id)!.sets.flatMap((s) => s.words);
    expect(kept.map((w) => w.word).sort()).toEqual(["cat", "dog"]);
    expect(kept.every((w) => w.meaning === "" && w.source === "classroom-quiz-show")).toBe(true);
    expect([...importedSourceIds(activities)].sort()).toEqual(["bank-a1-cat", "x2"]);
  });
  it("groups by level and category, at most ten words per set", () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ ...convertQuestion(q()).word!, id: `w${i}`, word: `w${i}` }));
    const sets = groupIntoSets(many);
    expect(sets.map((s) => s.words.length)).toEqual([10, 10, 3]);
    expect(sets[0].title).toBe("A1 Animals (1)");
  });
});

const REAL = `${homedir()}/Downloads/quiz-bank-2026-11-12-424-questions.json`;
describe.runIf(existsSync(REAL))("the real 424-question export (read only)", () => {
  const text = readFileSync(REAL, "utf8");
  const parsed = parseCqsExport(text);
  const report = parsed.ok ? convertExport(parsed.questions) : null;
  it("is read without being changed and converts with the safety guarantees", () => {
    expect(parsed.ok).toBe(true);
    expect(readFileSync(REAL, "utf8")).toBe(text);
    const r = report!;
    expect(r.counts.total).toBe(424);
    const converted = r.items.filter((i) => i.word);
    for (const i of converted) {
      expect(leaksTarget(i.word!, i.word!.category)).toBe(false);
      for (const h of i.word!.hints) expect(leaksTarget(i.word!, h)).toBe(false);
      expect(i.word!.hints).toHaveLength(3);
      expect(validateWord(i.word!).filter((x) => x.severity === "error")).toEqual([]);
    }
    expect(r.items.filter((i) => i.status === "skipped" && i.reasons[0]?.startsWith("Not imported")).length).toBe(6);
    // eslint-disable-next-line no-console
    console.log("REAL EXPORT", JSON.stringify(r.counts));
  });
});

import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { handleStudioRequest } from "./ai/service";
import { addSet, approvalProblems, approveSet, createActivity, setProgress, todaysWords, updateWord, wordsNeedingHints } from "./ops";
import { loadActivities, saveActivity, type StorageLike } from "./storage";
import { leaksTarget } from "./validation";
import { EMPTY_BRIEF, type Brief } from "./types";

const brief: Brief = { ...EMPTY_BRIEF, topic: "Places in town", level: "B1" };
const TEN = ["bakery", "library", "post office", "department store", "vehicle bureau", "pharmacy", "museum", "bus station", "town hall", "stadium"];
const GOOD_HINTS = (w: string) => [`You go there on a busy Saturday morning, number ${w.length}.`, "It has a particular smell and a particular sound inside it.", `Unlike a home, a ____ is a place you visit for one purpose (${w.length}).`];
const item = (word: string, hints = GOOD_HINTS(word)) => ({
  word, accept: [], partOfSpeech: "phrase", cefr: "B1", category: "Places in town", meaning: `a place in town (${word.length} letters)`,
  example: `We went to the ${word} yesterday.`, hints,
});
// the realistic defects: a natural hint that says "vehicle", and one that says "department"
const FLAWED: Record<string, string[]> = {
  "vehicle bureau": ["You go here to register your vehicle.", "Officials check forms and issue plates for each car.", "Unlike a garage, a ____ deals with paperwork."],
  "department store": ["You can buy clothes in every department here.", "It has many floors and a perfume counter near the door.", "Unlike a corner shop, a ____ sells almost everything."],
};
const GOOD_REPAIR = { hints: ["You go here with a form in your hand and wait for a number.", "Officials check papers and give you a small plastic card.", "Unlike a garage, a ____ deals with paperwork."] };

function route(handler: (user: string, call: number) => unknown) {
  let call = 0;
  const f = vi.fn(async (_u: unknown, init: unknown) => {
    const user = (JSON.parse(String((init as RequestInit).body)) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(handler(user, call++)) } }] }), { status: 200 });
  });
  const users = () => f.mock.calls.map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n"));
  return { f, users };
}
const listed = (user: string): string[] => { const m = /APPROVED this exact word list: (\[[^\]]*\])/.exec(user); return m ? JSON.parse(m[1]) : []; };
const gen = async (f: unknown, approved: string[]) => {
  const r = await handleStudioRequest({ task: "generate", brief, count: approved.length, exclude: [], approved }, { apiKey: "k", model: "m", fetchImpl: f as never });
  if (!r.body.ok || r.body.data.task !== "generate") throw new Error(`generate failed ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };

// The AI writes all ten items, but two have hints that fail validation, and rewriting keeps failing.
const stubbornAi = () => route((user) => {
  const asked = listed(user);
  if (asked.length) return { words: asked.map((w) => item(w, FLAWED[w] ?? GOOD_HINTS(w))) };
  return { hints: ["Every vehicle and every department is here.", "More about the vehicle and the department.", "Vehicle department again, for sure."] }; // a rewrite that is still wrong
});

describe("the reported case: 10 selected words, only 8 valid items", () => {
  it("all ten words stay; the two with defective hints are flagged with their exact hints and reasons", async () => {
    const ai = stubbornAi();
    const d = await gen(ai.f, TEN);
    expect(d.words.map((w) => w.word)).toEqual(TEN); // nothing disappears
    expect(d.failed).toBeUndefined();
    expect(d.flagged!.map((f) => f.word).sort()).toEqual(["department store", "vehicle bureau"]);
    const v = d.flagged!.find((f) => f.word === "vehicle bureau")!;
    expect(v.hints).toEqual([0]);
    expect(v.reason).toMatch(/Hint 1 gives away the word/);
    // item requests were not repeated for the 8 good words: one big request, then only small hint rewrites
    const lists = ai.users().map(listed).filter((l) => l.length);
    expect(lists).toEqual([TEN]);
    expect(ai.f.mock.calls.length).toBe(1 + 2 * 2); // 1 item request + 2 flagged words × 2 hint rewrites (bounded)
  });
  it("the lineup counts: 10 selected · 8 valid · 2 need correction, and the set cannot be approved", async () => {
    const d = await gen(stubbornAi().f, TEN);
    const a = addSet(createActivity("T", "2026-04-01T00:00:00Z"), d.words, { requested: 10, flaggedWords: d.flagged!.map((f) => f.word) });
    const set = a.sets[0];
    expect(setProgress(set)).toMatchObject({ approved: 10, written: 10, valid: 8, needCorrection: 2, needHints: 2 });
    const refused = approveSet(a, set.id);
    expect(refused.activity.sets[0].status).toBe("draft");
    expect(refused.problems.join(" ")).toMatch(/“vehicle bureau”.*hint 1/);
    expect(todaysWords([a])).toBeNull(); // not hostable
  });
});

describe("repairing only the hints of one word", () => {
  it("an automatic hint rewrite fixes the word without regenerating any other item", async () => {
    const ai = route((user) => {
      const asked = listed(user);
      if (asked.length) return { words: asked.map((w) => item(w, FLAWED[w] ?? GOOD_HINTS(w))) };
      return GOOD_REPAIR; // the small hints-only request succeeds
    });
    const d = await gen(ai.f, TEN);
    expect(d.words.map((w) => w.word)).toEqual(TEN);
    expect(d.flagged ?? []).toEqual([]);
    const lists = ai.users().map(listed).filter((l) => l.length);
    expect(lists).toEqual([TEN]); // the whole-set item request ran once
    const repairs = ai.users().filter((u) => !listed(u).length);
    expect(repairs).toHaveLength(2); // one small request per flawed word
    expect(repairs.some((u) => /vehicle bureau/.test(u))).toBe(true);
    expect(repairs.some((u) => /department store/.test(u))).toBe(true);
    for (const r of repairs) expect(r).toMatch(/Your previous hints were rejected/);
    // the eight good words keep their original hints exactly
    for (const w of d.words.filter((x) => !FLAWED[x.word])) expect(w.hints).toEqual(GOOD_HINTS(w.word));
  });
  it("the 'Rewrite hints' action (regenerate-hints) is validated and a failed rewrite changes nothing", async () => {
    const ai = route(() => ({ hints: ["You register your vehicle here.", "x", "y"] })); // still gives away "vehicle"
    const word = (await gen(stubbornAi().f, TEN)).words.find((w) => w.word === "vehicle bureau")!;
    const r = await handleStudioRequest({ task: "regenerate-hints", brief, word }, { apiKey: "k", model: "m", fetchImpl: ai.f as never });
    expect(r.body.ok).toBe(false); // rejected, so the app keeps the word and its current hints
    const ok = route(() => GOOD_REPAIR);
    const r2 = await handleStudioRequest({ task: "regenerate-hints", brief, word }, { apiKey: "k", model: "m", fetchImpl: ok.f as never });
    expect(r2.body.ok && r2.body.data.task === "regenerate-hints" && r2.body.data.hints).toEqual(GOOD_REPAIR.hints);
  });
  it("fixing the hints by hand clears the flag, and then the set can be approved and hosted — all ten words, in order", async () => {
    const d = await gen(stubbornAi().f, TEN);
    let a = addSet(createActivity("T", "2026-04-01T00:00:00Z"), d.words, { requested: 10, flaggedWords: d.flagged!.map((f) => f.word) });
    const id = a.sets[0].id;
    for (const w of ["vehicle bureau", "department store"]) {
      const target = a.sets[0].words.find((x) => x.word === w)!;
      expect(wordsNeedingHints(a.sets[0]).map((x) => x.word.word)).toContain(w);
      a = updateWord(a, id, target.id, { hints: GOOD_HINTS(w) });
    }
    expect(wordsNeedingHints(a.sets[0])).toEqual([]);
    expect(setProgress(a.sets[0])).toMatchObject({ approved: 10, valid: 10, needCorrection: 0 });
    const ok = approveSet(a, id);
    expect(ok.problems).toEqual([]);
    expect(todaysWords([ok.activity])!.words.map((w) => w.word)).toEqual(TEN);
  });
  it("a hand edit that is still wrong keeps the word flagged", async () => {
    const d = await gen(stubbornAi().f, TEN);
    const a = addSet(createActivity("T"), d.words, { requested: 10, flaggedWords: d.flagged!.map((f) => f.word) });
    const t = a.sets[0].words.find((x) => x.word === "vehicle bureau")!;
    const still = updateWord(a, a.sets[0].id, t.id, { hints: ["Visit the vehicle bureau.", ...GOOD_HINTS("x").slice(1)] });
    expect(wordsNeedingHints(still.sets[0]).map((x) => x.word.word).sort()).toEqual(["department store", "vehicle bureau"]);
  });
});

describe("saving, reloading and old sets", () => {
  it("flags and counts survive save and reload", async () => {
    const d = await gen(stubbornAi().f, TEN);
    const a = addSet(createActivity("T", "2026-04-01T00:00:00Z"), d.words, { requested: 10, flaggedWords: d.flagged!.map((f) => f.word) });
    const store = memory();
    expect(saveActivity(store, a).ok).toBe(true);
    const back = loadActivities(store).activities[0].sets[0];
    expect(back.flagged).toEqual(a.sets[0].flagged);
    expect(setProgress(back)).toMatchObject({ approved: 10, valid: 8, needCorrection: 2 });
  });
  it.each([1, 4, 10])("an existing %i-word set (never flagged) is unaffected and approves normally", (n) => {
    const words: VocabWord[] = SAMPLE_SET.words.slice(0, n).map((w, i) => ({ ...w, id: `e${n}-${i}` }));
    const a = addSet(createActivity("Old", "2026-01-01T00:00:00Z"), words);
    expect(approvalProblems(a.sets[0])).toEqual([]);
    expect(setProgress(a.sets[0])).toMatchObject({ approved: n, valid: n, needCorrection: 0 });
    expect(todaysWords([approveSet(a, a.sets[0].id).activity])!.words).toHaveLength(n);
  });
});

describe("hint validation no longer over-reaches on phrases", () => {
  const dept = { word: "department store", accept: [] as string[] };
  it("'story' and 'storage' are different words from 'store'", () => {
    expect(leaksTarget(dept, "It is not a story; it has a storage room.")).toBe(false);
    expect(leaksTarget({ word: "vehicle bureau", accept: [] }, "People sit in a bureaucratic queue.")).toBe(false);
  });
  it("the real words of the phrase are still caught, with ordinary forms", () => {
    for (const t of ["Every store has one.", "Many stores sell it.", "It was stored there.", "Each department is on its own floor."]) expect(leaksTarget(dept, t)).toBe(true);
    expect(leaksTarget({ word: "vehicle bureau", accept: [] }, "Register your vehicle here.")).toBe(true);
    expect(leaksTarget(dept, "You visit a department store.")).toBe(true);
  });
});

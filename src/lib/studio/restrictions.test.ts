import { describe, expect, it, vi } from "vitest";
import { handleStudioRequest, HINT_REPAIRS } from "./ai/service";
import { addSet, approveSet, createActivity, setBrief, setProgress, updateWord, wordsNeedingHints } from "./ops";
import { hintProblems } from "./validation";
import { parseRestrictions, restrictionProblems, restrictionsFor, withRestrictionNote } from "./restrictions";
import { EMPTY_BRIEF, type Brief } from "./types";

const NO_CAL = "Do not use calendar-order clues in Hints 1 and 2. Such clues are permitted in Hint 3.";
const brief = (focus = ""): Brief => ({ ...EMPTY_BRIEF, topic: "Weekdays", level: "A2", learnerFocus: focus });

describe("reading the teacher's restriction", () => {
  it("the reported instruction restricts hints 1 and 2 only", () => {
    expect(parseRestrictions([NO_CAL])).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
  });
  it("understands 'until Hint 3', 'only in Hint 3', and 'Hints 1 to 2'", () => {
    expect(parseRestrictions(["Avoid calendar-order clues until Hint 3."])).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
    expect(parseRestrictions(["Calendar-order clues only in Hint 3, please."])).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
    expect(parseRestrictions(["No calendar-order clues in hints 1 to 2."])).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
    expect(parseRestrictions(["Never give calendar-order clues."])).toEqual([{ kind: "calendar-order", hints: [0, 1, 2] }]);
  });
  it("recognises other checkable kinds and does not generalise to unrelated wishes", () => {
    expect(parseRestrictions(["Don't use first-letter clues."])).toEqual([{ kind: "first-letter", hints: [0, 1, 2] }]);
    expect(parseRestrictions(["No word origins in hint 1."])).toEqual([{ kind: "word-origin", hints: [0] }]);
    expect(parseRestrictions(["Use word origins for the weekdays when they are accurate."])).toEqual([]);
    expect(parseRestrictions(["Make it funny and use food examples. Avoid sad topics."])).toEqual([]);
    expect(parseRestrictions([""])).toEqual([]);
  });
  it("the LATEST instruction wins when the teacher changes their mind", () => {
    expect(parseRestrictions([NO_CAL, "Actually, calendar-order clues are fine now."])).toEqual([]);
    expect(parseRestrictions([NO_CAL, "Now avoid calendar-order clues in hint 3 as well."])).toEqual([{ kind: "calendar-order", hints: [0, 1, 2] }]);
    expect(parseRestrictions(["Calendar-order clues are fine.", "Avoid calendar-order clues in hint 1."])).toEqual([{ kind: "calendar-order", hints: [0] }]);
    // the one-off instruction is newest
    expect(restrictionsFor(NO_CAL, "Calendar-order clues are allowed this time.")).toEqual([]);
    expect(restrictionsFor("", NO_CAL)).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
  });
  it("a one-off restriction is remembered in the brief notes, newest last; other instructions are not", () => {
    expect(withRestrictionNote("Be friendly.", NO_CAL)).toBe(`Be friendly. ${NO_CAL}`);
    expect(withRestrictionNote("Be friendly.", "Make hint 1 about food")).toBe("Be friendly.");
    expect(withRestrictionNote("x".repeat(480), NO_CAL).length).toBeLessThanOrEqual(500);
    expect(withRestrictionNote("x".repeat(480), NO_CAL).endsWith("permitted in Hint 3.")).toBe(true);
  });
});

describe("checking hints (free, no model call)", () => {
  const r = parseRestrictions([NO_CAL]);
  it("catches the reported violation and the evaluation's real ones", () => {
    expect(restrictionProblems(["It is a day of the week that comes after Monday.", "x", "y"], r).map((p) => p.hintIndex)).toEqual([0]);
    expect(restrictionProblems(["a", "You might say 'It's the second day of the week' when asked.", "y"], r).map((p) => p.hintIndex)).toEqual([1]);
    expect(restrictionProblems(["People talk about it in the middle of the week.", "It is close to the weekend.", "z"], r).map((p) => p.hintIndex)).toEqual([0, 1]);
    expect(restrictionProblems(["x", "People are happy to start the new week on this day.", "y"], r)[0].message).toMatch(/Hint 2 has a calendar-order clue/);
  });
  it("allows the permitted hint and ordinary hints", () => {
    expect(restrictionProblems(["Its name is connected with a god of war.", "You may have a quiz on this day.", "It comes right after Monday."], r)).toEqual([]);
    expect(restrictionProblems(["You go out with friends after work.", "Dinner is at the end of a long day.", "z"], r)).toEqual([]);
  });
  it("first-letter and origin restrictions", () => {
    const f = parseRestrictions(["Don't use first-letter clues."]);
    expect(restrictionProblems(["a", "b", "A word that starts with 'u'."], f).map((p) => p.hintIndex)).toEqual([2]);
    const o = parseRestrictions(["No word origins in hint 1."]);
    expect(restrictionProblems(["The name comes from Latin.", "The name comes from Latin.", "b"], o).map((p) => p.hintIndex)).toEqual([0]);
  });
  it("hintProblems reports them as blocking hint errors, only when restrictions are given", () => {
    const w = { id: "w", word: "Tuesday", accept: [], partOfSpeech: "noun", cefr: "A1", category: "Days", meaning: "a day of the week", example: "See you Tuesday.", hints: ["It comes after Monday.", "People have class on this day.", "A quiz is usually given."] } as never;
    expect(hintProblems(w)).toEqual([]);
    const p = hintProblems(w, r);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ field: "hints", hintIndex: 0, severity: "error", code: "restriction" });
  });
});

// ---- generation, targeted repair, failed repair ---------------------------------------------------------------
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const CLEAN = (w: string) => [`The shop is closed and you remember your ${w.length}-letter plan.`, "People often have a regular class or meeting at that time.", "This is the one with its own old name connected with a god."];
const item = (word: string, hints: string[]) => ({ word, accept: [], partOfSpeech: "noun", cefr: "A1", category: "Days", meaning: "a day of the week", example: `We meet on ${word}.`, hints });
const BAD_H1 = "It is a day of the week that comes after Monday.";

function ai(opts: { badFor?: string[]; repairOutput?: (call: number, user: string) => unknown } = {}) {
  let repairs = 0;
  const f = vi.fn(async (_u: unknown, init: unknown) => {
    const msgs = (JSON.parse(String((init as RequestInit).body)) as { messages: { content: string }[] }).messages;
    const user = msgs[msgs.length - 1].content;
    const list = /APPROVED this exact word list: (\[[^\]]*\])/.exec(user);
    let out: unknown;
    if (list) out = { words: (JSON.parse(list[1]) as string[]).map((w) => item(w, opts.badFor?.includes(w) ? [BAD_H1, ...CLEAN(w).slice(1)] : CLEAN(w))) };
    else out = opts.repairOutput ? opts.repairOutput(repairs++, user) : { hints: ["You wake up and dread the class that starts this day.", "A second hint written by the repair, which is ignored.", "A third hint written by the repair, also ignored."] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }), { status: 200 });
  });
  const users = () => f.mock.calls.map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n"));
  return { f, users };
}
const gen = (f: unknown, over: Record<string, unknown> = {}, b = brief(NO_CAL)) =>
  handleStudioRequest({ task: "generate", brief: b, count: 5, exclude: [], approved: WEEK, ...over } as never, { apiKey: "k", model: "m", fetchImpl: f as never });
type GenData = { words: { word: string; hints: string[] }[]; flagged?: { word: string; reason: string; hints: number[] }[]; failed?: unknown[] };
const data = (r: Awaited<ReturnType<typeof gen>>) => { if (!r.body.ok) throw new Error(JSON.stringify(r.body)); return r.body.data as unknown as GenData; };

describe("generation with a restriction", () => {
  it("a violating hint is rewritten ALONE; the other hints and every other word stay exactly as written", async () => {
    const mock = ai({ badFor: ["Tuesday"] });
    const d = data(await gen(mock.f));
    expect(d.words.map((w) => w.word)).toEqual(WEEK);
    expect(d.flagged).toBeUndefined();
    const tue = d.words.find((w) => w.word === "Tuesday")!;
    expect(tue.hints[0]).toBe("You wake up and dread the class that starts this day."); // repaired
    expect(tue.hints[1]).toBe(CLEAN("Tuesday")[1]); // untouched, not the model's "ignored"
    expect(tue.hints[2]).toBe(CLEAN("Tuesday")[2]);
    for (const w of d.words.filter((x) => x.word !== "Tuesday")) expect(w.hints).toEqual(CLEAN(w.word));
    // cost: one item request + one small repair for the one affected word
    expect(mock.f.mock.calls.length).toBe(2);
    expect(mock.users()[1]).toMatch(/Only hint 1 must change/);
    expect(mock.users()[1]).toMatch(/calendar-order clue/);
  });
  it("a repair that keeps failing is capped, the word stays visible, and the exact hint is flagged", async () => {
    const mock = ai({ badFor: ["Tuesday", "Friday"], repairOutput: () => ({ hints: ["It comes before Wednesday.", "A second hint written by the repair, which is ignored.", "A third hint written by the repair, also ignored."] }) });
    const d = data(await gen(mock.f));
    expect(d.words.map((w) => w.word)).toEqual(WEEK); // nothing disappears
    expect(d.flagged!.map((f) => f.word).sort()).toEqual(["Friday", "Tuesday"]);
    expect(d.flagged![0].hints).toEqual([0]);
    expect(d.flagged![0].reason).toMatch(/calendar-order clue/);
    expect(d.words.find((w) => w.word === "Tuesday")!.hints[0]).toBe(BAD_H1); // the original is kept, not silently replaced
    expect(mock.f.mock.calls.length).toBe(1 + 2 * HINT_REPAIRS); // bounded
  });
  it("without a restriction the same hints are accepted and no extra call is made", async () => {
    const mock = ai({ badFor: ["Tuesday"] });
    const d = data(await gen(mock.f, {}, brief("Use meaningful associations.")));
    expect(d.flagged).toBeUndefined();
    expect(d.words.find((w) => w.word === "Tuesday")!.hints[0]).toBe(BAD_H1);
    expect(mock.f.mock.calls.length).toBe(1);
  });
  it("a one-off instruction is obeyed, and a newer 'allowed' instruction lifts the brief's restriction", async () => {
    const strict = ai({ badFor: ["Tuesday"] });
    const d1 = data(await gen(strict.f, { instruction: NO_CAL }, brief("")));
    expect(d1.words.find((w) => w.word === "Tuesday")!.hints[0]).not.toBe(BAD_H1);
    const lifted = ai({ badFor: ["Tuesday"] });
    const d2 = data(await gen(lifted.f, { instruction: "Calendar-order clues are fine now." }, brief(NO_CAL)));
    expect(d2.flagged).toBeUndefined();
    expect(lifted.f.mock.calls.length).toBe(1);
  });
  it("regenerate-hints refuses a rewrite that breaks the restriction", async () => {
    const mock = ai({ repairOutput: () => ({ hints: [BAD_H1, "People have class on this day.", "A quiz is usually given."] }) });
    const word = { id: "w", ...item("Tuesday", CLEAN("Tuesday")) } as never;
    const r = await handleStudioRequest({ task: "regenerate-hints", brief: brief(NO_CAL), word } as never, { apiKey: "k", model: "m", fetchImpl: mock.f as never });
    expect(r.body.ok).toBe(false);
    expect(mock.f.mock.calls.length).toBe(2); // two bounded tries
  });
});

// ---- the set: flagged → blocked, fixed → approved --------------------------------------------------------------
describe("approval is blocked until restriction violations are resolved", () => {
  const words = WEEK.map((w, i) => ({ id: `w${i}`, ...item(w, w === "Tuesday" ? [BAD_H1, ...CLEAN(w).slice(1)] : CLEAN(w)) })) as never[];
  const build = (focus: string) => addSet(setBrief(createActivity("T", "2026-04-01T00:00:00Z"), brief(focus)), words as never, { requested: 5 });

  it("an unresolved violation blocks approval and names the hint, even when it was never flagged", () => {
    const a = build(NO_CAL);
    const refused = approveSet(a, a.sets[0].id);
    expect(refused.activity.sets[0].status).toBe("draft");
    expect(refused.problems.join(" ")).toMatch(/“Tuesday” still needs its hints corrected \(hint 1:.*calendar-order clue/);
    expect(setProgress(a.sets[0], restrictionsFor(NO_CAL))).toMatchObject({ valid: 4, needCorrection: 1 });
    expect(wordsNeedingHints(a.sets[0], restrictionsFor(NO_CAL)).map((x) => x.word.word)).toEqual(["Tuesday"]);
  });
  it("fixing the hint by hand clears it, and then the set can be approved with all five words", () => {
    const a = build(NO_CAL);
    const id = a.sets[0].words.find((w) => w.word === "Tuesday")!.id;
    const fixed = updateWord(a, a.sets[0].id, id, { hints: ["You may have a quiz on this day.", CLEAN("x")[1], CLEAN("x")[2]] });
    const ok = approveSet(fixed, fixed.sets[0].id);
    expect(ok.problems).toEqual([]);
    expect(ok.activity.sets[0].words.map((w) => w.word)).toEqual(WEEK);
  });
  it("when the teacher later allows such clues, the same hints are accepted", () => {
    const a = setBrief(build(NO_CAL), brief(`${NO_CAL} Calendar-order clues are fine now.`));
    expect(approveSet(a, a.sets[0].id).problems).toEqual([]);
  });
  it("unrestricted vocabulary is unaffected", () => {
    const a = build("");
    expect(approveSet(a, a.sets[0].id).problems).toEqual([]);
    expect(setProgress(a.sets[0], restrictionsFor("")).needCorrection).toBe(0);
  });
});

describe("real model output from the Studio run (recorded)", () => {
  const r = parseRestrictions([NO_CAL]);
  const REAL: Record<string, string[]> = {
    Wednesday: ["Imagine you are halfway through your school week, and you look forward to the weekend ahead.", "Many students feel this day is important because it means they have done half of their classes for the week.", "People often say 'hump day' for this day."],
    Friday: ["This day is often celebrated because it leads to the weekend.", "People often go out with friends, or they might watch movies at home on this day.", "Many people finish work or school activities on this day."],
    Monday: ["Imagine a time when the weekend is over, and you have to get back to your job or classes.", "Many people say they feel tired or unhappy on this day because it means work starts again.", "It is often the day people complain about because of work or school starting again."],
  };
  it("flags the halfway / weekend-over / leads-to-the-weekend clues in hint 1, and leaves clean hints alone", () => {
    expect(restrictionProblems(REAL.Wednesday, r).map((p) => p.hintIndex)).toEqual([0]); // hint 2 ("half of their classes for the week") is too far from "week" to be caught: a known miss
    expect(restrictionProblems(REAL.Friday, r).map((p) => p.hintIndex)).toEqual([0]);
    expect(restrictionProblems(REAL.Monday, r).map((p) => p.hintIndex)).toEqual([0]);
    expect(restrictionProblems(["Many people have their classes or work this day.", "It is often seen as a day to be productive, especially in offices.", "x"], r)).toEqual([]);
  });
});

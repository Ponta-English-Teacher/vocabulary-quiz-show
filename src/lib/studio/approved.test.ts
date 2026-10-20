import { describe, expect, it, vi } from "vitest";
import { EMPTY_BRIEF, type Brief, type ChatResult } from "./types";
import { approvedPrompt, chatPrompt, generatePrompt, hintsPrompt } from "./ai/prompts";
import { enforceApproval, parseChatResult } from "./ai/parse";
import { mockChat } from "./ai/mock";
import { handleStudioRequest } from "./ai/service";
import { splitApproved } from "./ops";
import { isLetterOnlyHint, parseGeneratedWords, validateWord } from "./validation";
import { coerceWord } from "./validation";

const brief = (over: Partial<Brief> = {}): Brief => ({ ...EMPTY_BRIEF, topic: "Kitchen tools", level: "B1", ...over });
const APPROVED = ["knife", "grater", "pot", "pan", "peeler", "whisk", "spatula", "rolling pin", "zester", "colander"];

// good, non-generic, progressive hints that never contain the word
const item = (word: string, over: Record<string, unknown> = {}) => ({
  word, accept: [], partOfSpeech: "noun", cefr: "B1", category: "Kitchen tools", meaning: `a kitchen tool (${word.length} letters)`,
  example: `We used the ${word} for dinner.`,
  hints: [`You would reach for this on a busy weeknight, number ${word.length}.`, "It has a distinctive shape and is stored in a drawer or on a hook.", `Unlike a spoon, a ____ is meant for one particular job (${word.length}).`],
  ...over,
});
const reply = (payload: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
function fake(...payloads: unknown[]) {
  let i = 0;
  const f = vi.fn(async () => reply(payloads[Math.min(i++, payloads.length - 1)]));
  const prompt = (n: number) => (JSON.parse(String((f.mock.calls[n] as unknown as [string, RequestInit])[1].body)).messages as { content: string }[]).map((m) => m.content).join("\n");
  return { f, prompt };
}
const deps = (f: ReturnType<typeof vi.fn>) => ({ apiKey: "fake-key-for-tests", model: "test-model", fetchImpl: f as never });
async function generate(f: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) {
  const r = await handleStudioRequest({ task: "generate", brief: brief(), count: 10, exclude: [], approved: APPROVED, ...over }, deps(f));
  if (!r.body.ok || r.body.data.task !== "generate") throw new Error(`generate failed: ${JSON.stringify(r.body)}`);
  return r.body.data;
}

// =====================================================================================
describe("Fix 1 — approved candidates are preserved and used exactly", () => {
  const modelChat = (candidates: string[], pending: boolean, command: unknown = null) => ({
    reply: "…", ready: true, command,
    brief: { topic: "Kitchen tools", level: "B1", balance: "5 familiar / 5 less common", approvalPending: pending, candidates, approvedWords: ["HACK"] },
  });

  it("tracks the discussion's candidates, ignores anything the model puts in approvedWords, and freezes the list on approval", () => {
    const held = brief({ approvalPending: true, candidates: ["knife", "spoon"] });
    const parsed = parseChatResult(modelChat(APPROVED, true), held);
    expect(parsed.brief.candidates).toEqual(APPROVED);
    expect(parsed.brief.approvedWords).toEqual([]); // the model cannot set this itself
    const approved = enforceApproval(
      parseChatResult(modelChat(APPROVED, false, { type: "generate" }), held), brief({ approvalPending: true, candidates: APPROVED }), "Looks good, approved. Go ahead.",
    );
    expect(approved.command).toEqual({ type: "generate" });
    expect(approved.brief.approvedWords).toEqual(APPROVED);
    expect(approved.brief.approvalPending).toBe(false);
  });
  it("falls back to the previous candidates if the model forgets to repeat them at approval", () => {
    const res = parseChatResult(modelChat([], false, { type: "generate" }), brief({ approvalPending: true, candidates: APPROVED }));
    const out = enforceApproval(res, brief({ approvalPending: true, candidates: APPROVED }), "approved");
    expect(out.brief.approvedWords).toEqual(APPROVED);
  });
  it("clears any approved list while the teacher is still discussing, and approves nothing without a discussion", () => {
    const base: ChatResult = { reply: "x", ready: true, command: { type: "generate" }, brief: brief({ candidates: APPROVED, approvedWords: APPROVED, approvalPending: true }) };
    const out = enforceApproval(base, brief({ approvalPending: true, candidates: APPROVED }), "Swap the colander for a ladle.");
    expect(out.brief.approvedWords).toEqual([]);
    expect(out.command).toBeNull();
    const free = enforceApproval({ ...base, brief: brief() }, brief(), "generate");
    expect(free.brief.approvedWords).toEqual([]); // no discussion → free generation
  });
  it("the chat prompt tells the AI to keep the candidate list exact", () => {
    const sys = chatPrompt([{ role: "teacher", text: "hi" }], brief())[0].content;
    expect(sys).toMatch(/brief\.candidates/);
    expect(sys).toMatch(/applying the teacher's swaps exactly/);
    expect(sys).toMatch(/generation will use exactly these words/);
  });

  it("the generation request carries the approved words verbatim", async () => {
    const { f, prompt } = fake({ words: APPROVED.map((w) => item(w)) });
    await generate(f);
    expect(prompt(0)).toContain(JSON.stringify(APPROVED));
    expect(prompt(0)).toMatch(/Do NOT replace, drop, add, merge or respell any word/);
    expect(prompt(0)).toMatch(/exactly 10 items/);
  });
  it("returns EXACTLY the approved words, unchanged and in the teacher's order — never the model's own picks", async () => {
    const shuffled = [...APPROVED].reverse().map((w) => item(w.toUpperCase())); // wrong order + different capitalisation
    const { f } = fake({ words: shuffled });
    const d = await generate(f);
    expect(d.words.map((w) => w.word)).toEqual(APPROVED);
    expect(d.issues).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("drops substitutions and retries only the missing words", async () => {
    const first = [...APPROVED.slice(0, 7).map((w) => item(w)), item("mandoline"), item("sieve"), item("tongs")]; // model swaps in its own words
    const second = APPROVED.slice(7).map((w) => item(w));
    const { f, prompt } = fake({ words: first }, { words: second });
    const d = await generate(f);
    expect(d.words.map((w) => w.word)).toEqual(APPROVED);
    expect(d.issues.join(" ")).toMatch(/“mandoline” is not one of the approved words/);
    expect(f).toHaveBeenCalledTimes(2);
    expect(prompt(1)).toContain(JSON.stringify(APPROVED.slice(7))); // only what was missing
    expect(prompt(1)).not.toContain('"knife"');
  });
  it("never silently replaces an approved word it cannot write: reports it and keeps the rest", async () => {
    const answer = APPROVED.filter((w) => w !== "zester").map((w) => item(w));
    const { f } = fake({ words: answer }); // model never produces "zester"
    const d = await generate(f);
    expect(d.words.map((w) => w.word)).toEqual(APPROVED.filter((w) => w !== "zester"));
    expect(d.issues.join(" ")).toMatch(/Could not write valid items for approved word: zester/);
    expect(f).toHaveBeenCalledTimes(3); // capped
  });
  it("approved words are the teacher's choice: they are not blocked by the 'already in this activity' exclusion", async () => {
    const { f, prompt } = fake({ words: APPROVED.map((w) => item(w)) });
    const d = await generate(f, { exclude: ["knife", "whisk", "tongs"] });
    expect(d.words.map((w) => w.word)).toEqual(APPROVED);
    expect(prompt(0)).toContain('"knife"');
  });
  it("fewer than ten approved: those exact words first, the remainder generated separately without repeating them", async () => {
    const six = APPROVED.slice(0, 6);
    const extras = ["ladle", "tongs", "sieve", "peeler2", "masher"].map((w) => item(w));
    const { f, prompt } = fake({ words: six.map((w) => item(w)) }, { words: extras });
    const d = await generate(f, { approved: six });
    expect(d.words).toHaveLength(10);
    expect(d.words.slice(0, 6).map((w) => w.word)).toEqual(six);
    expect(prompt(1)).toMatch(/needs at least 4 valid/);
    for (const w of six) expect(prompt(1)).toContain(`"${w}"`); // do-not-repeat list
  });
  it("deduplicates the approved list and ignores blanks", async () => {
    const { f } = fake({ words: ["knife", "whisk"].map((w) => item(w)) });
    const d = await generate(f, { approved: ["knife", "Knife", " ", "whisk"], count: 2 });
    expect(d.words.map((w) => w.word)).toEqual(["knife", "whisk"]);
  });
  it("splits a long approved list into sets of ten in order", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `w${i}`);
    expect(splitApproved(twelve)).toEqual([twelve.slice(0, 10), twelve.slice(10)]);
    expect(splitApproved([])).toEqual([]);
  });
  it("end to end over the real service: discuss → swap → approve → generate gives the approved words", async () => {
    const turn1 = modelChat(APPROVED.slice(0, 9).concat("mandoline"), true);
    const turn2 = modelChat(APPROVED, true);
    const turn3 = modelChat(APPROVED, false, { type: "generate" });
    const { f } = fake(turn1, turn2, turn3, { words: APPROVED.map((w) => item(w)) });
    const say = async (text: string, b: Brief) => {
      const r = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text }], brief: b }, deps(f));
      if (!r.body.ok || r.body.data.task !== "chat") throw new Error("chat failed");
      return r.body.data.result;
    };
    const a = await say("Create B1 kitchen vocabulary. First suggest candidates and wait for my approval before generating.", brief());
    expect(a.command).toBeNull();
    const b = await say("Swap mandoline for a colander", a.brief);
    expect(b.brief.candidates).toEqual(APPROVED);
    expect(b.command).toBeNull();
    const c = await say("Approved — go ahead", b.brief);
    expect(c.command).toEqual({ type: "generate" });
    expect(c.brief.approvedWords).toEqual(APPROVED);
    const gen = await generate(f, { brief: c.brief, approved: c.brief.approvedWords });
    expect(gen.words.map((w) => w.word)).toEqual(APPROVED);
  });
  it("mock AI: discussion lists candidates, approval freezes them, and generation returns exactly those words", async () => {
    const say = (t: string, p: Brief) => mockChat([{ role: "teacher", text: t }], p);
    const a = say("B2 vocabulary about everyday physical actions. Suggest candidates first and wait for my approval.", EMPTY_BRIEF);
    expect(a.brief.candidates.length).toBeGreaterThan(5);
    const approved = enforceApproval(mockChat([{ role: "teacher", text: "go ahead" }], a.brief), a.brief, "go ahead");
    expect(approved.command).toEqual({ type: "generate" });
    expect(approved.brief.approvedWords).toEqual(a.brief.candidates);
    const r = await handleStudioRequest({ task: "generate", forceMock: true, brief: approved.brief, count: 10, exclude: [], approved: approved.brief.approvedWords }, {});
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("mock generate failed");
    expect(r.body.data.words.slice(0, approved.brief.approvedWords.length).map((w) => w.word)).toEqual(approved.brief.approvedWords);
  });
  it("the approved-words prompt forbids swapping words and re-levelling them", () => {
    const user = approvedPrompt(brief(), APPROVED)[1].content;
    expect(user).toContain(JSON.stringify(APPROVED));
    expect(user).toMatch(/do not swap in easier or more common words/);
    expect(user).toMatch(/do not adjust them to the requested level/);
  });
});

// =====================================================================================
describe("Fix 2 — hint quality and CEFR accuracy", () => {
  const rules = () => generatePrompt(brief(), 10, [])[0].content;

  it("instructions require progression, different kinds of clue, and ban generic and first-letter-only hints", () => {
    const r = rules();
    expect(r).toMatch(/PROGRESS — each strictly more informative/);
    expect(r).toMatch(/hint 1 = the OPENING HINT/);
    expect(r).toMatch(/hint 2 = distinctive features/);
    expect(r).toMatch(/hint 3 = strongest clue/);
    expect(r).toMatch(/NEVER a generic label like "it is a kitchen tool", "it is used in the kitchen"/);
    expect(r).toMatch(/NEVER write a hint that is just "The first letter is x"/);
    expect(r).toMatch(/at most one word in three/);
    expect(r).toMatch(/Do not reuse the same hint pattern/);
    // the same rules reach the other generation tasks
    expect(approvedPrompt(brief(), ["whisk"])[0].content).toMatch(/PROGRESS/);
    expect(hintsPrompt(brief(), { ...item("whisk"), id: "x" } as never)[0].content).toMatch(/PROGRESS/);
  });
  it("instructions demand honest CEFR labels, with calibration anchors", () => {
    const r = rules();
    expect(r).toMatch(/HONEST difficulty/);
    expect(r).toMatch(/A1 knife/);
    expect(r).toMatch(/B1 whisk, grater/);
    expect(r).toMatch(/Never label a word to match the requested level/);
  });
  it("recognises letter-only clues but not real hints that mention a letter", () => {
    for (const h of ["The first letter is 'k'.", "It starts with S.", "The first word starts with 'm'.", "It has two words, and the first starts with 'c'.", "Its first letter is Z"]) {
      expect(isLetterOnlyHint(h), h).toBe(true);
    }
    for (const h of ["Cakes are decorated with it, and it starts with S.", "You beat eggs with this in a bowl.", "It starts with a hard sound and slices bread."]) {
      expect(isLetterOnlyHint(h), h).toBe(false);
    }
  });
  it("AI items whose hints are letter-only are rejected (and the retry is told why)", async () => {
    const lazy = (w: string) => item(w, { hints: ["It's used while preparing food.", "It has a sharp edge here.", `The first letter is '${w[0]}'.`] });
    const { f, prompt } = fake({ words: ["knife", "whisk", "peeler"].map(lazy) }, { words: ["knife", "whisk", "peeler"].map((w) => item(w)) });
    const d = await generate(f, { approved: ["knife", "whisk", "peeler"], count: 3 });
    expect(d.words.map((w) => w.word)).toEqual(["knife", "whisk", "peeler"]);
    for (const w of d.words) expect(w.hints[2]).not.toMatch(/first letter/i);
    expect(d.issues.join(" ")).toMatch(/only gives the first letter/);
    expect(prompt(1)).toMatch(/only gives the first letter/);
  });
  it("teachers can still keep such a hint by hand — it is a warning, not a blocker", () => {
    const c = coerceWord(item("whisk", { hints: ["It's used while mixing batter.", "It has thin looped wires.", "The first letter is 'w'."] }));
    if (!("word" in c)) throw new Error();
    const issues = validateWord(c.word);
    expect(issues.some((i) => i.code === "letter-only" && i.severity === "warning" && i.hintIndex === 2)).toBe(true);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });
  it("very short hints get a warning", () => {
    const c = coerceWord(item("whisk", { hints: ["Used for mixing.", "It has wires.", "A strong clue that is longer than four words."] }));
    if (!("word" in c)) throw new Error();
    expect(validateWord(c.word).filter((i) => i.code === "too-short").length).toBe(2);
  });
  it("keeps the AI's own CEFR label even when it differs from the requested level (no silent re-labelling)", async () => {
    const mixed = [item("knife", { cefr: "A1" }), item("whisk", { cefr: "B1" }), item("zester", { cefr: "C1" })];
    const { f } = fake({ words: mixed });
    const d = await generate(f, { approved: ["knife", "whisk", "zester"], count: 3, brief: brief({ level: "B1" }) });
    expect(d.words.map((w) => w.cefr)).toEqual(["A1", "B1", "C1"]);
  });
  it("generic hints repeated across an item are flagged as a warning", () => {
    const c = coerceWord(item("whisk", { hints: ["You use it when you cook meals at home.", "You use it when you cook meals at home.", "It is a strong clue about eggs and cream."] }));
    if (!("word" in c)) throw new Error();
    expect(validateWord(c.word).some((i) => i.severity === "warning" && /identical/.test(i.message))).toBe(true);
    const parsed = parseGeneratedWords([item("whisk")]);
    expect(parsed.words).toHaveLength(1); // good hints pass untouched
  });
});

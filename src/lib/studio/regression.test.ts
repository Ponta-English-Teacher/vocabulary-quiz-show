import { describe, expect, it, vi } from "vitest";
import { EMPTY_BRIEF, type Brief } from "./types";
import { chatPrompt, generatePrompt } from "./ai/prompts";
import { APPROVAL_RE, DISCUSS_FIRST_RE, enforceApproval } from "./ai/parse";
import { mockChat } from "./ai/mock";
import { handleStudioRequest, MAX_GENERATE_ATTEMPTS } from "./ai/service";
import { addSet, allTargetForms, approveSet, createActivity, createSet, regenerateSet } from "./ops";
import type { ChatResult } from "./types";

const brief = (over: Partial<Brief> = {}): Brief => ({ ...EMPTY_BRIEF, ...over });
const KITCHEN =
  "Create B1-level vocabulary about kitchen tools. Include both familiar everyday tools and less common specialized tools. First suggest basic and less common candidates, explain the distinction, and wait for my approval before generating the final ten-word set.";

// ---- fakes (no network, no cost) ----------------------------------------------------
const item = (word: string, over: Record<string, unknown> = {}) => ({
  word, accept: [], partOfSpeech: "noun", cefr: "B1", category: "Kitchen tools", meaning: `meaning ${word}`,
  example: `A sentence about ${word}.`, hints: [`clue one for ${word.length}`, "clue two", "clue three"], ...over,
});
const reply = (payload: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
function fakeFetch(...payloads: unknown[]) {
  let i = 0;
  const f = vi.fn(async () => reply(payloads[Math.min(i++, payloads.length - 1)]));
  const bodies = () => f.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
  const userText = (n: number) => bodies()[n].messages.map((m: { content: string }) => m.content).join("\n");
  return { f, bodies, userText };
}
const deps = (f: ReturnType<typeof vi.fn>) => ({ apiKey: "fake-key-for-tests", model: "test-model", fetchImpl: f as never });
const names = (prefix: string, n: number, start = 0) => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + ((start + i) % 26))}${start + i}`);

// ====================================================================================
describe("Problem 1 — the teacher controls the vocabulary", () => {
  it("chat instructions put the teacher in charge and forbid narrowing the topic", () => {
    const sys = chatPrompt([{ role: "teacher", text: KITCHEN }], brief())[0].content;
    expect(sys).toMatch(/TEACHER AUTHORITY/);
    expect(sys).toMatch(/NEVER narrow, simplify or "improve" the teacher's topic/);
    expect(sys).toMatch(/Do NOT avoid specialised, rare or challenging vocabulary when the teacher asks for it/);
    expect(sys).toMatch(/Respect the requested balance exactly/);
    expect(sys).toMatch(/"Both familiar and less common\/specialised" means a real mix/);
    expect(sys).toMatch(/DISCUSSION FIRST/);
    expect(sys).toMatch(/Only when the teacher clearly approves/);
  });
  it("generation carries the teacher's balance and forbids swapping in easier words", () => {
    const b = brief({ topic: "Kitchen tools", level: "B1", balance: "A real mix of familiar and less common specialised tools" });
    const user = generatePrompt(b, 13, [], undefined, [], 10)[1].content;
    expect(user).toContain("A real mix of familiar and less common specialised tools");
    expect(user).toMatch(/do not narrow, broaden or change the topic/i);
    expect(user).toMatch(/do not swap in easier words/i);
  });
  it("detects 'discuss first' requests and clear approvals", () => {
    expect(DISCUSS_FIRST_RE.test(KITCHEN)).toBe(true);
    expect(DISCUSS_FIRST_RE.test("First suggest candidates please")).toBe(true);
    expect(DISCUSS_FIRST_RE.test("Create A1 vocabulary about common fruits.")).toBe(false);
    for (const ok of ["Looks good, go ahead", "approved", "Yes, generate it", "ok"]) expect(APPROVAL_RE.test(ok), ok).toBe(true);
    for (const no of ["swap whisk for tongs", "add a mandoline", "what about a colander?"]) expect(APPROVAL_RE.test(no), no).toBe(false);
  });

  const generateCmd: ChatResult = { reply: "Generating now!", ready: true, command: { type: "generate" }, brief: brief({ topic: "Kitchen tools", level: "B1" }) };
  it("blocks generation while the teacher is discussing, even if the model tries to generate", () => {
    const r = enforceApproval(generateCmd, brief(), KITCHEN);
    expect(r.command).toBeNull();
    expect(r.brief.approvalPending).toBe(true);
  });
  it("keeps holding through follow-up instructions, and releases only on approval", () => {
    const held = brief({ topic: "Kitchen tools", level: "B1", approvalPending: true });
    const follow = enforceApproval(generateCmd, held, "Swap the whisk for tongs and add a mandoline.");
    expect(follow.command).toBeNull();
    expect(follow.brief.approvalPending).toBe(true);
    const ok = enforceApproval({ ...generateCmd, brief: brief({ topic: "Kitchen tools", level: "B1" }) }, held, "Looks good — go ahead.");
    expect(ok.command).toEqual({ type: "generate" });
    expect(ok.brief.approvalPending).toBe(false);
  });
  it("does not interfere when the teacher never asked to wait", () => {
    expect(enforceApproval(generateCmd, brief(), "generate").command).toEqual({ type: "generate" });
  });
  it("end-to-end with a misbehaving model: the server still withholds generation until approval", async () => {
    const eager = { reply: "Here you go, generating!", ready: true, brief: { topic: "Kitchen tools", level: "B1", balance: "mix", approvalPending: false }, command: { type: "generate" } };
    const { f } = fakeFetch(eager);
    const first = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: KITCHEN }], brief: brief() }, deps(f));
    if (!first.body.ok || first.body.data.task !== "chat") throw new Error("unexpected");
    expect(first.body.data.result.command).toBeNull();
    expect(first.body.data.result.brief.approvalPending).toBe(true);
    const heldBrief = first.body.data.result.brief;
    const second = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: KITCHEN }, { role: "ai", text: "…" }, { role: "teacher", text: "Add a mandoline and a zester." }], brief: heldBrief }, deps(f));
    if (!second.body.ok || second.body.data.task !== "chat") throw new Error("unexpected");
    expect(second.body.data.result.command).toBeNull();
    const third = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: "Great, approved — go ahead." }], brief: second.body.data.result.brief }, deps(f));
    if (!third.body.ok || third.body.data.task !== "chat") throw new Error("unexpected");
    expect(third.body.data.result.command).toEqual({ type: "generate" });
    expect(third.body.data.result.brief.approvalPending).toBe(false);
  });
  it("mock AI follows the same discuss → adjust → approve → generate flow, and honours the balance", () => {
    const say = (text: string, prev: Brief) => mockChat([{ role: "teacher", text }], prev);
    const a = say("Make B2 vocabulary about common fruits and less common fruits. Suggest candidates first and wait for my approval before generating.", brief());
    expect(a.command).toBeNull();
    expect(a.brief.approvalPending).toBe(true);
    expect(a.reply).toMatch(/Candidates/);
    expect(a.reply).toMatch(/won't generate until you approve/);
    const b = say("Please add something more unusual", a.brief);
    expect(b.command).toBeNull();
    expect(b.brief.approvalPending).toBe(true);
    const c = say("go ahead", b.brief);
    expect(c.command).toEqual({ type: "generate" });
    expect(c.brief.approvalPending).toBe(false);
    const mix = say("B1 fruits, both familiar everyday and challenging less common ones", brief());
    expect(mix.brief.balance).toMatch(/mix of familiar/i);
  });
});

// ====================================================================================
describe("Problem 2 — pictures and the real hint concept", () => {
  const sys = () => chatPrompt([{ role: "teacher", text: "Can we use pictures as hints?" }], brief())[0].content;
  it("instructions describe the full intended hint system", () => {
    for (const part of [/spoken descriptions/i, /pictures and visual clues/i, /situational examples/i, /hints made up by the students/i, /AI help when a Giver cannot explain/i]) {
      expect(sys()).toMatch(part);
    }
  });
  it("tells the AI pictures are a FUTURE feature and must not be claimed or generated", () => {
    expect(sys()).toMatch(/planned FUTURE feature, NOT available yet/);
    expect(sys()).toMatch(/never claim they exist/);
    expect(sys()).toMatch(/never say hints must be verbal only/);
    expect(sys()).toMatch(/never produce images or image links/);
  });
  it("no longer contains the old 'never pictures' / verbal-only rule (in any prompt)", () => {
    const all = [sys(), generatePrompt(brief(), 10, []).map((m) => m.content).join("\n")].join("\n");
    expect(all).not.toMatch(/never pictures/i);
    expect(all).not.toMatch(/hints should only be verbal/i);
  });
  it("mock AI answers a picture question honestly: part of the design, not built yet, no action", () => {
    const r = mockChat([{ role: "teacher", text: "Could pictures be used as hints?" }], brief({ topic: "Common fruits", level: "A1" }));
    expect(r.reply).toMatch(/part of the intended hint design/);
    expect(r.reply).toMatch(/NOT available yet/);
    expect(r.reply).toMatch(/students make up themselves/);
    expect(r.reply).not.toMatch(/only verbal|verbal only/i);
    expect(r.command).toBeNull();
  });
});

// ====================================================================================
describe("Problem 3 — complete sets of ten", () => {
  const req = { task: "generate", brief: brief({ topic: "Kitchen tools", level: "B1" }), count: 10, exclude: [] as string[] };

  it("asks for a few extra items so rejects don't leave a gap", async () => {
    const { f, userText } = fakeFetch({ words: names("w", 13).map((w) => item(w)) });
    const r = await handleStudioRequest(req, deps(f));
    expect(r.status).toBe(200);
    expect(userText(0)).toMatch(/exactly 13 items/);
    expect(f).toHaveBeenCalledTimes(1);
    if (r.body.ok && r.body.data.task === "generate") expect(r.body.data.words).toHaveLength(10); else throw new Error();
  });
  it("replenishes automatically: 8 valid + invalid/duplicate items → a second request fills the gap to exactly 10", async () => {
    const first = [...names("a", 8).map((w) => item(w)), item("leaky", { hints: ["it is a leaky thing", "b", "c"] }), item("aa0")]; // 8 ok, 1 leak, 1 dup of a…
    first[9] = item(names("a", 8)[0]); // exact duplicate of the first valid word
    const second = names("b", 5).map((w) => item(w));
    const { f, userText } = fakeFetch({ words: first }, { words: second });
    const r = await handleStudioRequest(req, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("unexpected");
    const words = r.body.data.words.map((w) => w.word);
    expect(words).toHaveLength(10);
    expect(new Set(words.map((w) => w.toLowerCase())).size).toBe(10);
    expect(words.slice(0, 8)).toEqual(names("a", 8)); // earlier valid words kept, in order
    expect(f).toHaveBeenCalledTimes(2);
    // the retry asks only for the shortfall (+extras), excludes what we already have, and reports the problems
    expect(userText(1)).toMatch(/needs at least 2 valid/);
    expect(userText(1)).toContain(names("a", 8)[0]);
    expect(userText(1)).toMatch(/previous attempt had problems/i);
    expect(userText(1)).toMatch(/gives away the word/);
    // invalid & duplicate items are identified for the teacher
    expect(r.body.data.issues.join(" ")).toMatch(/gives away/);
    expect(r.body.data.issues.join(" ")).toMatch(/duplicate/);
    expect(r.body.data.requested).toBe(10);
  });
  it("tells the teacher honestly when ten valid words can't be produced, within a capped number of calls", async () => {
    const same = { words: names("z", 8).map((w) => item(w)) }; // model keeps returning the same 8
    const { f } = fakeFetch(same);
    const r = await handleStudioRequest(req, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("unexpected");
    expect(r.body.data.words).toHaveLength(8);
    expect(r.body.data.requested).toBe(10);
    expect(r.body.data.issues.length).toBeGreaterThan(0);
    expect(r.body.data.issues.join(" ")).toMatch(/duplicate/);
    expect(f).toHaveBeenCalledTimes(MAX_GENERATE_ATTEMPTS);
  });
  it("keeps what it has if a follow-up request fails, and says so", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(reply({ words: names("m", 8).map((w) => item(w)) }))
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const r = await handleStudioRequest(req, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("unexpected");
    expect(r.body.data.words).toHaveLength(8);
    expect(r.body.data.issues.join(" ")).toMatch(/follow-up request failed/);
  });
  it("fails safely (nothing added) when nothing usable comes back", async () => {
    const { f } = fakeFetch({ words: [{ junk: 1 }] });
    const r = await handleStudioRequest(req, deps(f));
    expect(r.status).toBe(502);
  });
  it("never repeats words the activity already has (the teacher's previous sets)", async () => {
    const { f, userText } = fakeFetch({ words: [item("whisk"), ...names("n", 12).map((w) => item(w))] });
    const r = await handleStudioRequest({ ...req, exclude: ["whisk", "ladle"] }, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("unexpected");
    expect(r.body.data.words.map((w) => w.word)).not.toContain("whisk");
    expect(userText(0)).toContain('"whisk"');
  });

  it("previously approved sets are never touched by generating, regenerating or adding sets", () => {
    const wordsA = names("p", 10).map((w) => ({ ...item(w), id: `id-${w}`, partOfSpeech: "noun" as const, cefr: "B1" as const, hints: ["x1", "x2", "x3"] }));
    let a = { ...createActivity("Kitchen"), sets: [createSet(wordsA, "Set 1")] };
    a = approveSet(a, a.sets[0].id).activity;
    const approved = a.sets[0];
    expect(approved.status).toBe("approved");
    // a second set is generated/added: the approved set is the same object, still approved
    const wordsB = names("q", 10).map((w) => ({ ...item(w), id: `id-${w}`, partOfSpeech: "noun" as const, cefr: "B1" as const, hints: ["x1", "x2", "x3"] }));
    const withB = addSet(a, wordsB);
    expect(withB.sets[0]).toBe(approved);
    expect(allTargetForms(withB)).toEqual(expect.arrayContaining(wordsA.map((w) => w.word))); // sent as "do not repeat"
    // regenerating Set 2 leaves Set 1 alone
    const regen = regenerateSet(withB, withB.sets[1].id, names("r", 10).map((w) => ({ ...item(w), id: `n-${w}`, partOfSpeech: "noun" as const, cefr: "B1" as const, hints: ["x1", "x2", "x3"] })));
    expect(regen.activity.sets[0]).toBe(approved);
    expect(regen.activity.sets[0].status).toBe("approved");
  });
});

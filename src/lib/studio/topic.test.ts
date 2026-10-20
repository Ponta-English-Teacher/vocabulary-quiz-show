import { describe, expect, it, vi } from "vitest";
import { EMPTY_BRIEF, type Brief, type ChatResult } from "./types";
import { approvedPrompt, chatPrompt, generatePrompt, replacePrompt } from "./ai/prompts";
import { enforceApproval, enforceMixture, parseChatResult, requestedBands } from "./ai/parse";
import { mockChat } from "./ai/mock";
import { handleStudioRequest } from "./ai/service";
import { expectedPartsOfSpeech, parseGeneratedWords } from "./validation";
import type { VocabWord } from "@/data/vocab";

const brief = (over: Partial<Brief> = {}): Brief => ({ ...EMPTY_BRIEF, topic: "kitchen tools", level: "B2", ...over });
const item = (word: string, pos = "noun", cefr = "B1") => ({
  word, accept: [], partOfSpeech: pos, cefr, category: "Kitchen", meaning: `something of ${word.length} letters`, example: `I need the ${word}.`,
  hints: [`You would reach for this on a busy evening, number ${word.length}.`, "It has a distinctive shape and a particular job.", `Unlike a bowl, a ____ is made for one task (${word.length}).`],
});
const reply = (payload: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
function fake(...payloads: unknown[]) {
  let i = 0;
  const f = vi.fn(async () => reply(payloads[Math.min(i++, payloads.length - 1)]));
  const prompt = (n: number) => (JSON.parse(String((f.mock.calls[n] as unknown as [string, RequestInit])[1].body)).messages as { content: string }[]).map((m) => m.content).join("\n");
  return { f, prompt };
}
const deps = (f: ReturnType<typeof vi.fn>) => ({ apiKey: "fake-key-for-tests", model: "test-model", fetchImpl: f as never });
const TOOLS = ["knife", "grater", "pot", "pan", "peeler", "whisk", "spatula", "colander", "ladle", "zester", "mandoline", "tongs"];
const VERBS = ["boil", "stir", "saute", "simmer"];

// =====================================================================================
describe("1 · Topic accuracy — the teacher's exact topic and kind of word", () => {
  it("understands what kind of word the topic asks for, and stays silent when unclear", () => {
    expect(expectedPartsOfSpeech("Kitchen tools")?.allowed).toEqual(["noun", "phrase"]);
    expect(expectedPartsOfSpeech("cooking actions")?.allowed).toEqual(["verb", "phrase"]);
    expect(expectedPartsOfSpeech("Everyday physical actions")?.allowed).toEqual(["verb", "phrase"]);
    expect(expectedPartsOfSpeech("useful expressions")?.allowed).toEqual(["phrase"]);
    expect(expectedPartsOfSpeech("Personality and emotions")).toBeNull();
    expect(expectedPartsOfSpeech("Kitchen", "objects and utensils (nouns)")?.allowed).toContain("noun");
    expect(expectedPartsOfSpeech("action tools")).toBeNull(); // ambiguous → no enforcement
  });
  it("'Kitchen tools' rejects cooking verbs but accepts noun compounds like 'rolling pin'", () => {
    const list = [item("knife"), item("boil", "verb"), item("rolling pin", "phrase"), item("saute", "verb"), item("whisk")];
    const { words, issues } = parseGeneratedWords(list, { topic: "kitchen tools" });
    expect(words.map((w) => w.word)).toEqual(["knife", "rolling pin", "whisk"]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/“boil”\): this is a verb, but the requested topic “kitchen tools” asks for objects and utensils/);
  });
  it("'Cooking actions' rejects utensils but accepts verbs and phrasal verbs", () => {
    const list = [item("boil", "verb"), item("whisk", "noun"), item("chop up", "phrase"), item("knife", "noun")];
    const { words } = parseGeneratedWords(list, { topic: "cooking actions" });
    expect(words.map((w) => w.word)).toEqual(["boil", "chop up"]);
  });
  it("no topic check when the topic is unclear (e.g. personality words are not restricted)", () => {
    const list = [item("stubborn", "adjective"), item("patience", "noun"), item("hesitate", "verb")];
    expect(parseGeneratedWords(list, { topic: "personality and emotions" }).words).toHaveLength(3);
  });
  it("real-AI generation: verbs sneaking into 'kitchen tools' are rejected and replaced, and the retry says why", async () => {
    const first = [...TOOLS.slice(0, 7).map((w) => item(w)), ...VERBS.map((w) => item(w, "verb"))];
    const second = TOOLS.slice(7).map((w) => item(w));
    const { f, prompt } = fake({ words: first }, { words: second });
    const r = await handleStudioRequest({ task: "generate", brief: brief(), count: 10, exclude: [] }, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("failed");
    expect(r.body.data.words).toHaveLength(10);
    expect(r.body.data.words.every((w) => w.partOfSpeech === "noun")).toBe(true);
    expect(r.body.data.words.map((w) => w.word)).not.toEqual(expect.arrayContaining(["boil"]));
    expect(r.body.data.issues.join(" ")).toMatch(/asks for objects and utensils/);
    expect(prompt(1)).toMatch(/asks for objects and utensils/); // the model is told what went wrong
  });
  it("replacing one word under 'kitchen tools' won't accept a verb", async () => {
    const { f } = fake({ word: item("boil", "verb") }, { word: item("tongs") });
    const cur = { id: "x", ...item("knife") } as unknown as VocabWord;
    const r = await handleStudioRequest({ task: "replace-word", brief: brief(), current: cur, exclude: [] }, deps(f));
    if (!r.body.ok || r.body.data.task !== "replace-word") throw new Error("failed");
    expect(r.body.data.word.word).toBe("tongs");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("teacher-approved words are never filtered by topic type", async () => {
    const { f } = fake({ words: [item("whisk"), item("simmer", "verb")] });
    const r = await handleStudioRequest({ task: "generate", brief: brief(), count: 2, exclude: [], approved: ["whisk", "simmer"] }, deps(f));
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("failed");
    expect(r.body.data.words.map((w) => w.word)).toEqual(["whisk", "simmer"]);
  });
  it("every prompt carries the topic-accuracy rule with the tools/actions example", () => {
    const cur = { id: "x", ...item("knife") } as unknown as VocabWord;
    const prompts = [
      chatPrompt([{ role: "teacher", text: "hi" }], brief())[0].content,
      generatePrompt(brief(), 10, [])[0].content,
      approvedPrompt(brief(), ["whisk"])[0].content,
      replacePrompt(brief(), cur, [])[0].content,
    ];
    for (const p of prompts) {
      expect(p).toMatch(/TOPIC ACCURACY/);
      expect(p).toMatch(/"Kitchen tools" means objects and utensils \(nouns\) — NOT cooking verbs/);
      expect(p).toMatch(/"Cooking actions" means verbs — NOT utensils/);
      expect(p).toMatch(/Never broaden, narrow or change the category on your own/);
      expect(p).toMatch(/do not rename it to something broader such as "kitchen vocabulary"/);
    }
    const g = generatePrompt(brief({ wordType: "objects and utensils (nouns)" }), 10, [])[1].content;
    expect(g).toContain('topic: "kitchen tools"');
    expect(g).toContain("word type: objects and utensils (nouns)");
  });
});

// =====================================================================================
describe("2 · Vocabulary mixture — familiar / moderately challenging / unfamiliar, teacher-controlled", () => {
  const chat = (over: Partial<ChatResult["brief"]>): ChatResult => ({ reply: "Here are my candidates.", ready: true, command: null, brief: brief({ approvalPending: true, balance: "half familiar", ...over }) });
  const ASK = "I want a mix: some everyday words, some moderately challenging, and a few unfamiliar ones. Suggest candidates first.";

  it("instructions require explicit groups with examples from each requested group, and forbid CEFR sorting or a fixed distribution", () => {
    const sys = chatPrompt([{ role: "teacher", text: ASK }], brief())[0].content;
    expect(sys).toMatch(/present the candidates in explicit groups/);
    expect(sys).toMatch(/"familiar".*"moderate".*"unfamiliar"/s);
    expect(sys).toMatch(/Include examples from EVERY group the teacher asked for/);
    expect(sys).toMatch(/NOT CEFR cut-offs, so do not sort by CEFR label and do not enforce any fixed distribution/);
    expect(sys).toMatch(/The teacher sets the balance and counts; follow them exactly/);
    expect(sys).toMatch(/"candidateBands"/);
  });
  it("detects which groups the teacher asked for", () => {
    expect(requestedBands(ASK).bands.sort()).toEqual(["familiar", "moderate", "unfamiliar"]);
    expect(requestedBands("a mix of everyday and less common words").bands.sort()).toEqual(["familiar", "unfamiliar"]);
    expect(requestedBands("a range of difficulty").bands).toHaveLength(3);
    const generic = requestedBands("both familiar and challenging words");
    expect(generic.bands.sort()).toEqual(["familiar", "moderate"]);
    expect(generic.challengingOnly).toBe(true);
  });
  it("sanitises grouped candidates and derives the flat list from them (they can never disagree)", () => {
    const parsed = parseChatResult({
      reply: "x", brief: { topic: "kitchen tools", level: "B2", candidates: ["WRONG"], candidateBands: { familiar: ["knife", "pan"], moderate: ["grater"], unfamiliar: ["zester"] }, approvalPending: true },
    }, brief());
    expect(parsed.brief.candidateBands).toEqual({ familiar: ["knife", "pan"], moderate: ["grater"], unfamiliar: ["zester"] });
    expect(parsed.brief.candidates).toEqual(["knife", "pan", "grater", "zester"]);
    // flat-only (no groups) still works
    const flat = parseChatResult({ reply: "x", brief: { candidates: ["a", "b"] } }, brief());
    expect(flat.brief.candidates).toEqual(["a", "b"]);
  });
  it("a missing group the teacher asked for gets a plain heads-up — nothing is invented or forced", () => {
    const missing = chat({ candidateBands: { familiar: ["knife", "pan"], moderate: ["grater", "peeler"], unfamiliar: [] }, candidates: ["knife", "pan", "grater", "peeler"] });
    const out = enforceMixture(missing, ASK);
    expect(out.reply).toMatch(/Heads-up: you asked for a range of difficulty/);
    expect(out.reply).toMatch(/any unfamiliar words/);
    expect(out.reply).toMatch(/the balance is yours to set/);
    expect(out.brief.candidates).toEqual(missing.brief.candidates); // no words added behind the teacher's back
    expect(out.command).toBeNull();
  });
  it("no heads-up when every requested group is represented, or when no range was asked for", () => {
    const full = chat({ candidateBands: { familiar: ["knife"], moderate: ["grater"], unfamiliar: ["zester"] }, candidates: ["knife", "grater", "zester"] });
    expect(enforceMixture(full, ASK).reply).toBe(full.reply);
    const only = chat({ candidateBands: { familiar: ["knife", "pan"], moderate: [], unfamiliar: [] }, candidates: ["knife", "pan"], balance: "" });
    expect(enforceMixture(only, "Suggest basic kitchen tools").reply).toBe(only.reply);
    // "challenging" in general terms is satisfied by either moderate or unfamiliar words
    const generic = chat({ candidateBands: { familiar: ["knife"], moderate: [], unfamiliar: ["zester"] }, candidates: ["knife", "zester"] });
    expect(enforceMixture(generic, "both familiar and challenging words").reply).toBe(generic.reply);
  });
  it("the teacher controls the balance: counts are not forced, and bands don't have to agree with CEFR labels", async () => {
    // the AI puts a B2-labelled word in 'familiar' and an A1 word in 'moderate' — no complaint, because bands are not CEFR rules
    const model = { reply: "Here is my proposal.", ready: true, command: null, brief: { topic: "kitchen tools", level: "B2", balance: "mostly familiar, one unfamiliar", approvalPending: true, candidateBands: { familiar: ["colander", "pan", "pot", "knife"], moderate: ["spoon"], unfamiliar: ["chinois"] } } };
    const { f } = fake(model);
    const r = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: "Mostly familiar tools, one unfamiliar, wait for my approval." }], brief: brief() }, deps(f));
    if (!r.body.ok || r.body.data.task !== "chat") throw new Error("failed");
    expect(r.body.data.result.brief.candidates).toEqual(["colander", "pan", "pot", "knife", "spoon", "chinois"]);
    expect(r.body.data.result.reply).toBe("Here is my proposal."); // untouched
  });
  it("on approval the frozen list is exactly the grouped candidates, in group order", () => {
    const bands = { familiar: ["knife", "pan"], moderate: ["grater"], unfamiliar: ["zester"] };
    const held = brief({ approvalPending: true, candidates: ["knife", "pan", "grater", "zester"], candidateBands: bands });
    const parsed = parseChatResult({ reply: "ok", ready: true, command: { type: "generate" }, brief: { topic: "kitchen tools", approvalPending: false, candidateBands: bands } }, held);
    const out = enforceApproval(parsed, held, "Approved, go ahead");
    expect(out.brief.approvedWords).toEqual(["knife", "pan", "grater", "zester"]);
  });
  it("mock AI shows the three groups with examples and keeps the teacher's balance", () => {
    const r = mockChat([{ role: "teacher", text: "B2 everyday physical actions. I want a mix of familiar, moderately challenging and unfamiliar words. Suggest candidates and wait for my approval." }], EMPTY_BRIEF);
    expect(r.reply).toMatch(/Familiar: /);
    expect(r.reply).toMatch(/Moderately challenging: /);
    expect(r.reply).toMatch(/Unfamiliar: /);
    for (const g of ["familiar", "moderate", "unfamiliar"] as const) expect(r.brief.candidateBands[g].length).toBeGreaterThan(0);
    expect(r.brief.candidates).toEqual([...r.brief.candidateBands.familiar, ...r.brief.candidateBands.moderate, ...r.brief.candidateBands.unfamiliar]);
    expect(r.brief.wordType).toBe("actions (verbs)");
    expect(r.brief.approvalPending).toBe(true);
    expect(r.command).toBeNull();
  });
});

// =====================================================================================
describe("3 · Communication first", () => {
  it("instructions require explaining how the words support partner interaction, descriptions, questions and negotiation of meaning", () => {
    const sys = chatPrompt([{ role: "teacher", text: "hi" }], brief())[0].content;
    expect(sys).toMatch(/explain briefly HOW this vocabulary supports communication between the two students/);
    expect(sys).toMatch(/which familiar words the Giver can use to describe the harder ones/);
    expect(sys).toMatch(/what questions the Taker can ask/);
    expect(sys).toMatch(/negotiate meaning/);
    expect(sys).toMatch(/Never present CEFR uniformity as a sign of quality/);
  });
  it("the mock's discussion explains the communication value and disclaims CEFR sorting", () => {
    const r = mockChat([{ role: "teacher", text: "B2 everyday physical actions, a mix of difficulty. Discuss candidates first and wait for my approval." }], EMPTY_BRIEF);
    expect(r.reply).toMatch(/How this helps communication/);
    expect(r.reply).toMatch(/familiar words are tools for explaining/);
    expect(r.reply).toMatch(/Taker can ask questions/);
    expect(r.reply).toMatch(/negotiate meaning/);
    expect(r.reply).toMatch(/not sorting by CEFR level/);
    expect(r.reply).toMatch(/won't generate until you approve/);
  });
  it("quality is never judged by CEFR uniformity: mixed-level sets are accepted without complaint", () => {
    const list = [["knife", "A1"], ["whisk", "B1"], ["zester", "C1"], ["chinois", "C2"]].map(([w, c]) => item(w, "noun", c));
    const { words, issues } = parseGeneratedWords(list, { topic: "kitchen tools" });
    expect(words.map((w) => w.cefr)).toEqual(["A1", "B1", "C1", "C2"]);
    expect(issues).toEqual([]);
  });
});

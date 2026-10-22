import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createInitialState, gameReducer } from "@/lib/game";
import { selectWords } from "@/lib/playCount";
import { handleStudioRequest } from "./ai/service";
import { chatPrompt } from "./ai/prompts";
import { addCandidate, countCandidates, groupedCandidates, mergeAiCandidates, removeCandidate, replaceCandidate } from "./candidates";
import { activityFromSample, addSet, approvalProblems, approveSet, createActivity, reopenSet, splitApproved, todaysWords, updateWord } from "./ops";
import { loadActivities, parseActivity, saveActivity, type StorageLike } from "./storage";
import { EMPTY_BRIEF, type Brief, type ChatResult } from "./types";

const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };
const proposed = (over: Partial<Brief> = {}): Brief => ({
  ...EMPTY_BRIEF, topic: "Kitchen tools", level: "B1", approvalPending: true,
  candidates: ["knife", "grater", "whisk", "zester", "colander", "ladle"],
  candidateBands: { familiar: ["knife"], moderate: ["grater", "whisk"], unfamiliar: ["zester", "colander", "ladle"] },
  ...over,
});
const ok = (r: { ok: boolean; brief?: Brief; error?: string }): Brief => { if (!r.ok || !r.brief) throw new Error(r.error); return r.brief; };

describe("editing the candidate list by hand", () => {
  it("shows the number of candidates", () => {
    expect(countCandidates(proposed())).toBe(6);
  });
  it("edits ONE word in place, keeping its position and group, and leaves every other word alone", () => {
    const b = ok(replaceCandidate(proposed(), "zester", "zesters"));
    expect(b.candidates).toEqual(["knife", "grater", "whisk", "zesters", "colander", "ladle"]);
    expect(b.candidateBands.unfamiliar).toEqual(["zesters", "colander", "ladle"]);
    expect(b.candidateBands.familiar).toEqual(["knife"]);
  });
  it("replaces one word with a different one (same slot); the old word counts as deleted", () => {
    const b = ok(replaceCandidate(proposed(), "ladle", "spatula"));
    expect(b.candidates).toEqual(["knife", "grater", "whisk", "zester", "colander", "spatula"]);
    expect(b.candidateBands.unfamiliar).toContain("spatula");
    expect(b.removedCandidates).toEqual(["ladle"]);
    expect(b.pinnedCandidates).toEqual(["spatula"]);
  });
  it("deletes one word without touching the others or regenerating anything", () => {
    const before = proposed();
    const b = ok(removeCandidate(before, "grater"));
    expect(b.candidates).toEqual(["knife", "whisk", "zester", "colander", "ladle"]);
    expect(b.candidateBands.moderate).toEqual(["whisk"]);
    expect(b.removedCandidates).toEqual(["grater"]);
    expect(before.candidates).toHaveLength(6); // the original brief is not mutated
  });
  it("adds a word by hand (under 'Your words'), refusing blanks, duplicates and overflow", () => {
    const b = ok(addCandidate(proposed(), "  rolling   pin "));
    expect(b.candidates.at(-1)).toBe("rolling pin");
    expect(groupedCandidates(b).at(-1)).toEqual({ key: "other", words: ["rolling pin"] });
    expect(addCandidate(b, "ROLLING PIN").ok).toBe(false);
    expect(addCandidate(b, "   ").ok).toBe(false);
    const full = proposed({ candidates: Array.from({ length: 20 }, (_, i) => `w${i}`), candidateBands: { familiar: [], moderate: [], unfamiliar: [] } });
    expect(addCandidate(full, "extra").ok).toBe(false);
  });
  it("refuses to replace a word with one already in the list", () => {
    expect(replaceCandidate(proposed(), "ladle", "knife").ok).toBe(false);
  });
  it("re-adding a deleted word is the teacher's choice and clears the deletion", () => {
    const b = ok(addCandidate(ok(removeCandidate(proposed(), "ladle")), "ladle"));
    expect(b.removedCandidates).toEqual([]);
    expect(b.candidates).toContain("ladle");
  });
});

describe("the conversation continues after hand edits", () => {
  const edited = () => ok(addCandidate(ok(replaceCandidate(ok(removeCandidate(proposed(), "grater")), "ladle", "spatula")), "rolling pin"));

  it("merge: deleted words don't return, typed words aren't dropped, other AI words follow the AI", () => {
    const ai = proposed({ candidates: ["knife", "grater", "whisk", "zester", "colander", "ladle", "peeler"], candidateBands: { familiar: ["knife", "peeler"], moderate: ["grater", "whisk"], unfamiliar: ["zester", "colander", "ladle"] } });
    const m = mergeAiCandidates(edited(), ai);
    expect(m.candidates).not.toContain("grater");
    expect(m.candidates).not.toContain("ladle");
    expect(m.candidates).toEqual(expect.arrayContaining(["knife", "whisk", "zester", "colander", "peeler", "spatula", "rolling pin"]));
    expect(m.removedCandidates).toEqual(["grater", "ladle"]);
  });
  it("merge: an AI that forgets the teacher's own words doesn't lose them, but may drop its own", () => {
    const ai = proposed({ candidates: ["knife", "whisk"], candidateBands: { familiar: ["knife"], moderate: ["whisk"], unfamiliar: [] } });
    const m = mergeAiCandidates(edited(), ai);
    expect(m.candidates).toEqual(expect.arrayContaining(["knife", "whisk", "spatula", "rolling pin"]));
    expect(m.candidates).not.toContain("zester"); // the AI itself dropped its own suggestion on request
  });
  it("merge: the AI can never change the teacher's bookkeeping or the approved list", () => {
    const ai = proposed({ pinnedCandidates: ["x"], removedCandidates: [], approvedWords: ["evil"] });
    const m = mergeAiCandidates(edited(), ai);
    expect(m.removedCandidates).toEqual(["grater", "ladle"]);
    expect(m.pinnedCandidates).not.toContain("x");
  });

  const mockSay = async (text: string, b: Brief) => {
    const r = await handleStudioRequest({ task: "chat", forceMock: true, messages: [{ role: "teacher", text }], brief: b }, {});
    if (!r.body.ok || r.body.data.task !== "chat") throw new Error("chat failed");
    return r.body.data.result;
  };
  it("mock AI: talking on keeps the hand-edited list (server side)", async () => {
    const start = (await mockSay("B2 vocabulary about everyday physical actions. Suggest candidates first and wait for my approval.", EMPTY_BRIEF)).brief;
    const mine = ok(addCandidate(ok(removeCandidate(start, start.candidates[0])), "gesticulate"));
    const gone = start.candidates[0];
    const next = (await mockSay("Could you make these a bit more fun? Still wait for my approval.", mine)).brief;
    expect(next.candidates).not.toContain(gone);
    expect(next.candidates).toContain("gesticulate");
    expect(next.candidates).toHaveLength(mine.candidates.length);
    expect(next.removedCandidates).toEqual([gone]);
  });
  it("'go ahead' approves exactly the teacher's edited list", async () => {
    const start = (await mockSay("B2 vocabulary about everyday physical actions. Suggest candidates first and wait for my approval.", EMPTY_BRIEF)).brief;
    const mine = ok(addCandidate(ok(removeCandidate(start, start.candidates[1])), "gesticulate"));
    const r = await mockSay("go ahead", mine);
    expect(r.command).toEqual({ type: "generate" });
    expect(r.brief.approvedWords).toEqual(mine.candidates);
    expect(r.brief.approvedWords).toContain("gesticulate");
    expect(r.brief.approvedWords).not.toContain(start.candidates[1]);
  });
  it("live AI path: a model that re-proposes deleted words and forgets typed ones is corrected", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reply: "Here you go.", ready: true, command: null,
      brief: { topic: "Kitchen tools", level: "B1", approvalPending: true, candidates: ["knife", "grater", "whisk", "ladle"], candidateBands: { familiar: ["knife"], moderate: ["grater", "whisk"], unfamiliar: ["ladle"] } },
    }) } }] }), { status: 200 }));
    const mine = edited();
    const r = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: "Anything else?" }], brief: mine }, { apiKey: "k", model: "m", fetchImpl: f as never });
    if (!r.body.ok || r.body.data.task !== "chat") throw new Error("chat failed");
    const c: ChatResult = r.body.data.result;
    expect(c.brief.candidates).not.toContain("grater");
    expect(c.brief.candidates).not.toContain("ladle");
    expect(c.brief.candidates).toEqual(expect.arrayContaining(["spatula", "rolling pin", "knife", "whisk"]));
    expect(c.brief.removedCandidates).toEqual(["grater", "ladle"]);
  });
  it("the AI is told the teacher's current list and the words they deleted", () => {
    const sys = chatPrompt([{ role: "teacher", text: "hi" }], edited())[0].content;
    expect(sys).toContain(JSON.stringify(edited().candidates));
    expect(sys).toMatch(/authoritative/);
    expect(sys).toMatch(/never propose these again/);
    expect(sys).toContain(JSON.stringify(["grater", "ladle"]));
    expect(chatPrompt([{ role: "teacher", text: "hi" }], EMPTY_BRIEF)[0].content).not.toMatch(/never propose these again/);
  });
});

describe("saving, reloading and old activities", () => {
  it("candidate edits survive save and reload", () => {
    const store = memory();
    const mine = ok(addCandidate(ok(removeCandidate(proposed(), "grater")), "rolling pin"));
    const a = { ...createActivity("T", "2026-01-01T00:00:00Z"), brief: mine };
    expect(saveActivity(store, a).ok).toBe(true);
    const back = loadActivities(store).activities[0].brief;
    expect(back.candidates).toEqual(mine.candidates);
    expect(back.pinnedCandidates).toEqual(["rolling pin"]);
    expect(back.removedCandidates).toEqual(["grater"]);
    expect(back).toEqual(mine);
  });
  it("an activity saved before this feature loads with empty edit lists", () => {
    const old = JSON.parse(JSON.stringify(activityFromSample()));
    delete old.brief.pinnedCandidates; delete old.brief.removedCandidates;
    const a = parseActivity(old)!;
    expect(a.brief.pinnedCandidates).toEqual([]);
    expect(a.brief.removedCandidates).toEqual([]);
    expect(a.sets[0].words).toHaveLength(10);
    expect(a.sets[0].status).toBe("approved");
  });
});

describe("approval keeps the teacher's exact words, and sets can be any size", () => {
  const words = (n: number) => SAMPLE_SET.words.slice(0, n).map((w, i) => ({ ...w, id: `v${n}-${i}` }));
  it.each([1, 3, 5, 7, 10])("a %i-word set can be approved, is Today's Words, and plays all its words", (n) => {
    const a = addSet(createActivity("T", "2026-02-01T00:00:00Z"), words(n));
    expect(approvalProblems(a.sets[0])).toEqual([]);
    const r = approveSet(a, a.sets[0].id);
    expect(r.problems).toEqual([]);
    const t = todaysWords([r.activity])!;
    expect(t.words.map((w) => w.word)).toEqual(SAMPLE_SET.words.slice(0, n).map((w) => w.word));
    let s = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words: selectWords(t.words, n) });
    expect(s.words).toHaveLength(n);
    s = gameReducer(s, { type: "CONTINUE" });
    expect(Object.keys(s.statuses)).toHaveLength(n);
  });
  it("an empty set or one over ten words is still refused", () => {
    const a = addSet(createActivity("T"), words(3));
    expect(approvalProblems({ ...a.sets[0], words: [] })).not.toEqual([]);
    expect(approvalProblems({ ...a.sets[0], words: [...words(10), ...words(1).map((w) => ({ ...w, id: "zz", word: "zzz" }))] })).not.toEqual([]);
  });
  it("a teacher list of 14 words becomes sets of 10 and 4, with no padding", () => {
    const list = Array.from({ length: 14 }, (_, i) => `word${i}`);
    expect(splitApproved(list).map((c) => c.length)).toEqual([10, 4]);
  });
  it("generation from a short teacher list returns exactly those words in order, with no padding (mock AI)", async () => {
    const start = (await handleStudioRequest({ task: "chat", forceMock: true, messages: [{ role: "teacher", text: "B2 vocabulary about everyday physical actions. Suggest candidates first and wait for my approval." }], brief: EMPTY_BRIEF }, {}));
    if (!start.body.ok || start.body.data.task !== "chat") throw new Error("chat failed");
    const five = start.body.data.result.brief.candidates.slice(0, 5);
    const m = await handleStudioRequest({ task: "generate", forceMock: true, brief: proposed(), count: 5, exclude: [], approved: five }, {});
    if (!m.body.ok || m.body.data.task !== "generate") throw new Error("mock generate failed");
    expect(m.body.data.words.map((w) => w.word)).toEqual(five);
  });
  it("generation from a short teacher list returns exactly those words with the live path too", async () => {
    const list = ["knife", "grater", "whisk"];
    const item = (word: string) => ({ word, accept: [], partOfSpeech: "noun", cefr: "B1", category: "Kitchen tools", meaning: `a kitchen tool (${word.length} letters)`, example: `We used the ${word} for dinner.`,
      hints: [`You would reach for this on a busy weeknight, number ${word.length}.`, "It has a distinctive shape and is stored in a drawer or on a hook.", `Unlike a spoon, a ____ is meant for one particular job (${word.length}).`] });
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ words: list.map(item) }) } }] }), { status: 200 }));
    const r = await handleStudioRequest({ task: "generate", brief: proposed(), count: 3, exclude: [], approved: list }, { apiKey: "k", model: "m", fetchImpl: f as never });
    if (!r.body.ok || r.body.data.task !== "generate") throw new Error("generate failed");
    expect(r.body.data.words.map((w) => w.word)).toEqual(list);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("the approved set is unchanged by chat, and only an explicit reopen makes it editable again", () => {
    const a = activityFromSample();
    const id = a.sets[0].id;
    const snapshot = JSON.stringify(a.sets);
    expect(reopenSet(createActivity("x"), "nope").sets).toEqual([]);
    const reopened = reopenSet(a, id);
    expect(reopened.sets[0].status).toBe("draft");
    expect(reopened.sets[0].words).toEqual(a.sets[0].words);
    expect(JSON.stringify(a.sets)).toBe(snapshot); // pure: the approved original is untouched
    expect(reopenSet(reopened, id)).toBe(reopened); // reopening a draft is a no-op
    expect(approveSet(updateWord(reopened, id, a.sets[0].words[0].id, { meaning: "changed" }), id).problems).toEqual([]);
  });
  it("a smaller hosted activity works in a classroom with the chosen count", async () => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: "T", words: words(3) });
    expect(created.ok && created.activity.words.length).toBe(3);
  });
});

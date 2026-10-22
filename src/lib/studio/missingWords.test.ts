import { describe, expect, it, vi } from "vitest";
import { selectWords } from "@/lib/playCount";
import { handleStudioRequest } from "./ai/service";
import { addSet, approvalProblems, approveSet, createActivity, dropMissing, fillMissing, noteMissingFailure, setProgress, todaysWords } from "./ops";
import { loadActivities, parseActivity, saveActivity, type StorageLike } from "./storage";
import { EMPTY_BRIEF, type Brief } from "./types";
import type { VocabWord } from "@/data/vocab";

const brief: Brief = { ...EMPTY_BRIEF, topic: "Kitchen tools", level: "B1" };
const NINE = ["knife", "grater", "whisk", "zester", "colander", "ladle", "peeler", "spatula", "tongs"];

// A well-formed item for `word`: progressive hints that never contain it.
const item = (word: string, over: Record<string, unknown> = {}) => ({
  word, accept: [], partOfSpeech: "noun", cefr: "B1", category: "Kitchen tools", meaning: `a kitchen tool (${word.length} letters)`,
  example: `We used the ${word} for dinner.`,
  hints: [`You would reach for this on a busy weeknight, number ${word.length}.`, "It has a distinctive shape and is stored in a drawer or on a hook.", `Unlike a spoon, a ____ is meant for one particular job (${word.length}).`],
  ...over,
});
const leaky = (word: string) => item(word, { hints: [`You would reach for this on a busy weeknight, number ${word.length}.`, `A ${word} has a distinctive shape.`, "Unlike a spoon, a ____ does one particular job."] });
const vague = (word: string) => item(word, { hints: ["It is a kitchen tool.", "It has a distinctive shape and is stored in a drawer or on a hook.", `Unlike a spoon, a ____ is meant for one particular job (${word.length}).`] });

const reply = (payload: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
function fakeAi(respond: (askedFor: string[], call: number) => unknown[]) {
  let call = 0;
  const f = vi.fn(async (_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { messages: { content: string }[] };
    const user = body.messages.map((m) => m.content).join("\n");
    const listed = /APPROVED this exact word list: (\[[^\]]*\])/.exec(user);
    const asked: string[] = listed ? JSON.parse(listed[1]) : [];
    return reply({ words: respond(asked, call++) });
  });
  const askedLists = () => f.mock.calls.map((c) => {
    const user = (JSON.parse(String((c[1] as RequestInit).body)) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
    const m = /APPROVED this exact word list: (\[[^\]]*\])/.exec(user);
    return m ? (JSON.parse(m[1]) as string[]) : [];
  });
  return { f, askedLists };
}
const generate = async (f: unknown, approved: string[], count = approved.length) => {
  const r = await handleStudioRequest({ task: "generate", brief, count, exclude: [], approved }, { apiKey: "fake-key", model: "m", fetchImpl: f as never });
  if (!r.body.ok || r.body.data.task !== "generate") throw new Error(`generate failed: ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };

describe("9 approved words → 9 items", () => {
  it("returns exactly the 9 approved words, in order, with nothing failed", async () => {
    const ai = fakeAi((asked) => asked.map((w) => item(w)));
    const d = await generate(ai.f, NINE);
    expect(d.words.map((w) => w.word)).toEqual(NINE);
    expect(d.failed).toBeUndefined();
    expect(ai.f).toHaveBeenCalledTimes(1);
  });
});

describe("the AI returns fewer items than requested (the reported bug)", () => {
  it("7 of 9 → the 7 are kept and the 2 missing words are NAMED, never dropped silently", async () => {
    const ai = fakeAi((asked) => asked.filter((w) => w !== "ladle" && w !== "tongs").map((w) => item(w)));
    const d = await generate(ai.f, NINE);
    expect(d.words.map((w) => w.word)).toEqual(NINE.filter((w) => w !== "ladle" && w !== "tongs"));
    expect(d.failed?.map((f) => f.word)).toEqual(["ladle", "tongs"]);
    expect(d.failed?.every((f) => f.reason.length > 10)).toBe(true);
    // The retries asked ONLY for the missing words (the successful items were not requested again).
    const lists = ai.askedLists();
    expect(lists[0]).toEqual(NINE);
    for (const l of lists.slice(1)) expect(l).toEqual(["ladle", "tongs"]);
  });
  it("7 first, then the other 2 on the automatic retry → all 9, in the teacher's order", async () => {
    const ai = fakeAi((asked, call) => (call === 0 ? asked.slice(0, 7) : asked).map((w) => item(w)));
    const d = await generate(ai.f, NINE);
    expect(d.words.map((w) => w.word)).toEqual(NINE);
    expect(d.failed).toBeUndefined();
    expect(ai.askedLists()[1]).toEqual(["spatula", "tongs"]);
  });
  it("the AI renaming a word is not accepted as a substitute", async () => {
    const ai = fakeAi((asked) => asked.map((w) => item(w === "tongs" ? "tweezers" : w)));
    const d = await generate(ai.f, NINE);
    expect(d.words.map((w) => w.word)).not.toContain("tweezers");
    expect(d.failed?.map((f) => f.word)).toEqual(["tongs"]);
  });
});

describe("items that fail validation are identified with the reason", () => {
  it("one hint that gives the word away → that exact word, with that reason", async () => {
    const ai = fakeAi((asked) => asked.map((w) => (w === "zester" ? leaky(w) : item(w))));
    const d = await generate(ai.f, NINE);
    expect(d.words).toHaveLength(8);
    expect(d.failed).toHaveLength(1);
    expect(d.failed![0].word).toBe("zester");
    expect(d.failed![0].reason).toMatch(/gives away|contains|target|word/i);
  });
  it("two items with a generic opening hint → both named; the other seven are untouched", async () => {
    const ai = fakeAi((asked) => asked.map((w) => (w === "knife" || w === "ladle" ? vague(w) : item(w))));
    const d = await generate(ai.f, NINE);
    expect(d.words.map((w) => w.word)).toEqual(NINE.filter((w) => w !== "knife" && w !== "ladle"));
    expect(d.failed!.map((f) => f.word)).toEqual(["knife", "ladle"]);
    expect(d.failed![0].reason).toMatch(/Hint 1|situation|label/i);
  });
});

describe("duplicates", () => {
  it("a repeated approved word is written once; an item whose accepted spelling collides with another word is reported", async () => {
    const ai = fakeAi((asked) => asked.map((w) => item(w, w === "tongs" ? { accept: ["knife"] } : {})));
    const d = await generate(ai.f, [...NINE, "KNIFE"], 9);
    expect(d.words.filter((w) => w.word.toLowerCase() === "knife")).toHaveLength(1);
    expect(d.failed?.map((f) => f.word)).toEqual(["tongs"]);
    expect(d.failed![0].reason).toMatch(/duplicate/i);
  });
});

describe("retrying one failed word keeps everything else", () => {
  const nineWords = async (failing: string[]) => {
    const ai = fakeAi((asked) => asked.filter((w) => !failing.includes(w)).map((w) => item(w)));
    return generate(ai.f, NINE);
  };
  const setup = async (failing: string[]) => {
    const d = await nineWords(failing);
    const missing = d.failed!.map((f) => ({ word: f.word, reason: f.reason, index: NINE.indexOf(f.word) }));
    const a = addSet(createActivity("T", "2026-03-01T00:00:00Z"), d.words, { requested: 9, missing });
    return { a, set: a.sets[0], d };
  };
  it("a one-word retry asks the AI for that word only and fills its original slot, leaving the other items identical", async () => {
    const { a, set } = await setup(["ladle", "tongs"]);
    const ai = fakeAi((asked) => asked.map((w) => item(w)));
    const retry = await generate(ai.f, ["ladle"], 1);
    expect(ai.askedLists()).toEqual([["ladle"]]);
    const r = fillMissing(a, set.id, "ladle", retry.words[0]);
    expect(r.error).toBeUndefined();
    const s = r.activity.sets[0];
    expect(s.words.map((w) => w.word)).toEqual(["knife", "grater", "whisk", "zester", "colander", "ladle", "peeler", "spatula"]);
    set.words.forEach((w) => expect(s.words.find((x) => x.id === w.id)).toBe(w)); // the very same objects: not regenerated
    expect(s.missing?.map((m) => m.word)).toEqual(["tongs"]);
    expect(setProgress(s)).toEqual({ approved: 9, written: 8, failed: 1 });
  });
  it("a failed retry keeps the word waiting with the new reason and changes nothing else", async () => {
    const { a, set } = await setup(["tongs"]);
    const b = noteMissingFailure(a, set.id, "tongs", "still no good");
    expect(b.sets[0].words).toBe(a.sets[0].words);
    expect(b.sets[0].missing?.[0]).toMatchObject({ word: "tongs", reason: "still no good" });
  });
  it("only an explicit remove drops a missing word", async () => {
    const { a, set } = await setup(["tongs"]);
    const b = dropMissing(a, set.id, "tongs");
    expect(b.sets[0].missing).toBeUndefined();
    expect(b.sets[0].words).toHaveLength(8);
    expect(setProgress(b.sets[0])).toEqual({ approved: 8, written: 8, failed: 0 });
  });
});

describe("a set with missing items is not approved or hosted", () => {
  it("is blocked from approval (naming the words), not offered as Today's Words, until every word is written", async () => {
    const ai0 = fakeAi((asked) => asked.filter((w) => w !== "ladle" && w !== "tongs").map((w) => item(w)));
    const d = await generate(ai0.f, NINE);
    const a = addSet(createActivity("T", "2026-03-01T00:00:00Z"), d.words, { requested: 9, missing: d.failed!.map((f) => ({ ...f, index: NINE.indexOf(f.word) })) });
    const id = a.sets[0].id;
    expect(approvalProblems(a.sets[0]).join(" ")).toMatch(/2 approved words have no item yet.*ladle.*tongs/);
    const refused = approveSet(a, id);
    expect(refused.problems.length).toBeGreaterThan(0);
    expect(refused.activity.sets[0].status).toBe("draft");
    expect(todaysWords([a])).toBeNull();
    // retry both words
    const ai = fakeAi((asked) => asked.map((w) => item(w)));
    let cur = a;
    for (const w of ["ladle", "tongs"]) cur = fillMissing(cur, id, w, (await generate(ai.f, [w], 1)).words[0] as VocabWord).activity;
    expect(cur.sets[0].missing).toBeUndefined();
    const ok = approveSet(cur, id);
    expect(ok.problems).toEqual([]);
    const t = todaysWords([ok.activity])!;
    expect(t.words.map((w) => w.word)).toEqual(NINE); // exactly the approved nine, in the teacher's order
    expect(selectWords(t.words, 9)).toHaveLength(9);
  });
});

describe("saving and reloading", () => {
  it("keeps the counts, the missing words and their reasons", async () => {
    const ai = fakeAi((asked) => asked.filter((w) => w !== "tongs").map((w) => item(w)));
    const d = await generate(ai.f, NINE);
    const a = addSet(createActivity("T", "2026-03-01T00:00:00Z"), d.words, { requested: 9, missing: d.failed!.map((f) => ({ ...f, index: 8 })) });
    const store = memory();
    expect(saveActivity(store, a).ok).toBe(true);
    const back = loadActivities(store).activities[0].sets[0];
    expect(back.requested).toBe(9);
    expect(back.missing).toEqual(a.sets[0].missing);
    expect(back.words).toEqual(a.sets[0].words);
    expect(setProgress(back)).toEqual({ approved: 9, written: 8, failed: 1 });
  });
});

describe("existing sets of any size keep working", () => {
  const ten = () => selectWords(parseActivityWords(10), 10);
  function parseActivityWords(n: number): VocabWord[] {
    return Array.from({ length: n }, (_, i) => {
      const c = parseGenerated(item(`word${i}x`));
      return c;
    });
  }
  function parseGenerated(raw: unknown): VocabWord {
    // go through the same coercion saved activities use
    const act = parseActivity({ id: "a", sets: [{ id: "s", words: [raw] }] })!;
    return act.sets[0].words[0];
  }
  it.each([3, 9, 10])("a %i-word set saved before this change (no requested/missing) approves and hosts as Today's Words", (n) => {
    const words = ten().slice(0, n);
    const legacy = JSON.parse(JSON.stringify(addSet(createActivity("Old", "2026-01-01T00:00:00Z"), words)));
    const a = parseActivity(legacy)!;
    expect(a.sets[0].missing).toBeUndefined();
    expect(a.sets[0].requested).toBeUndefined();
    expect(setProgress(a.sets[0])).toEqual({ approved: n, written: n, failed: 0 });
    const r = approveSet(a, a.sets[0].id);
    expect(r.problems).toEqual([]);
    expect(todaysWords([r.activity])!.words).toHaveLength(n);
  });
});

describe("a plain 'go ahead' approves the list the teacher was shown", () => {
  const shown: Brief = { ...EMPTY_BRIEF, topic: "Kitchen tools", level: "B1", approvalPending: true, candidates: NINE, candidateBands: { familiar: [], moderate: [], unfamiliar: [] } };
  const chat = async (text: string, aiList: string[]) => {
    const f = vi.fn(async () => reply({ reply: "Great.", ready: true, command: { type: "generate" }, brief: { topic: "Kitchen tools", level: "B1", approvalPending: false, candidates: aiList } }));
    const r = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text }], brief: shown }, { apiKey: "k", model: "m", fetchImpl: f as never });
    if (!r.body.ok || r.body.data.task !== "chat") throw new Error("chat failed");
    return r.body.data.result;
  };
  it("a model that returns only 7 of the 9 on 'go ahead' cannot shrink the approved list", async () => {
    const r = await chat("go ahead", NINE.slice(0, 7));
    expect(r.command).toEqual({ type: "generate" });
    expect(r.brief.approvedWords).toEqual(NINE);
  });
  it("but a teacher who asks to drop a word gets the shorter list", async () => {
    const r = await chat("please remove the tongs and go ahead", NINE.slice(0, 8));
    expect(r.brief.approvedWords).toEqual(NINE.slice(0, 8));
  });
});

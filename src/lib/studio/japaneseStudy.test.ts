import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VocabWord } from "@/data/vocab";
import { StudyJapanese, StudyList } from "@/components/study/StudyList";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { checkJapaneseAnswer } from "@/lib/japanese";
import { createInitialState, gameReducer } from "@/lib/game";
import { handleStudioRequest } from "./ai/service";
import { generatePrompt, japanesePrompt } from "./ai/prompts";
import { libraryLists } from "./library";
import { addSet, approveSet, createActivity } from "./ops";
import { loadActivities, saveActivity, STORAGE_KEY, type StorageLike } from "./storage";
import { EMPTY_BRIEF, type Brief } from "./types";

const CLASSROOM = ["desk", "blackboard", "screen", "wall", "window", "bulletin board", "projector", "highlighter", "locker"];
const JA: Record<string, string[]> = {
  desk: ["机", "デスク"], blackboard: ["黒板"], screen: ["スクリーン", "画面"], wall: ["壁"], window: ["窓"],
  "bulletin board": ["掲示板"], projector: ["プロジェクター"], highlighter: ["蛍光ペン"], locker: ["ロッカー"],
};
const brief: Brief = { ...EMPTY_BRIEF, topic: "Classroom objects", level: "A2" };
const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };

/** What a model returns for one approved word. Hints are chosen so they pass the app's own checks. */
const item = (word: string, i: number, ja?: string[]) => ({
  word, accept: [], partOfSpeech: "noun", cefr: "A2", category: "Classroom", meaning: `a classroom thing, number ${i}`, example: `We use the ${word} in class.`,
  hints: [`You notice it first when you walk in, number ${i}.`, "Teachers and students look at it every day.", "It has a clear job in a school room."], ...(ja ? { ja } : {}),
});
function route(handler: (user: string, call: number) => unknown) {
  let call = 0;
  const f = vi.fn(async (_u: unknown, init: unknown) => {
    const user = (JSON.parse(String((init as RequestInit).body)) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(handler(user, call++)) } }] }), { status: 200 });
  });
  return f;
}
const gen = (f: unknown, fill: boolean, approved = CLASSROOM) =>
  handleStudioRequest({ task: "generate", brief, count: approved.length, exclude: [], approved } as never, { apiKey: "k", model: "m", fetchImpl: f as never, fillJapanese: fill });
type GenData = { words: VocabWord[]; issues: string[]; failed?: unknown[]; flagged?: unknown[] };
const data = (r: Awaited<ReturnType<typeof gen>>) => { if (!r.body.ok) throw new Error(JSON.stringify(r.body)); return r.body.data as unknown as GenData; };
const asked = (user: string) => { const m = /APPROVED this exact word list: (\[[^\]]*\])/.exec(user); return m ? (JSON.parse(m[1]) as string[]) : null; };

describe("why Japanese was missing, and the generation fix", () => {
  it("the item instructions now make Japanese required for every item (empty only if the word has no equivalent)", () => {
    const s = generatePrompt(brief, 3, [])[0].content;
    expect(s).toMatch(/EVERY item needs this field/);
    expect(s).toMatch(/"desk" → \["机", "デスク"\]/);
    expect(s).toMatch(/Use an empty array ONLY when the target truly has no Japanese equivalent/);
    expect(s).toMatch(/never merely related words/);
  });
  it("items the model wrote WITHOUT Japanese get one small follow-up request; the rest of each item is untouched", async () => {
    const f = route((user) => {
      const list = asked(user);
      if (list) return { words: list.map((w, i) => item(w, i)) }; // the model forgot every ja
      return { ja: JA };
    });
    const d = data(await gen(f, true));
    expect(f).toHaveBeenCalledTimes(2); // one for the items, one batched Japanese request for all nine
    expect(d.words.map((w) => w.word)).toEqual(CLASSROOM);
    expect(d.words.map((w) => w.ja)).toEqual(CLASSROOM.map((w) => JA[w]));
    expect(d.words[0].hints).toEqual(item("desk", 0).hints); // hints untouched
    expect(d.failed).toBeUndefined();
    const second = (JSON.parse(String((f.mock.calls[1][1] as RequestInit).body)) as { messages: { content: string }[] }).messages[1].content;
    expect(second).toContain("blackboard");
    expect(second).not.toMatch(/Teachers and students look at it/); // hints are not sent to the translation request
  });
  it("a Japanese list the model DID write is never replaced, and no follow-up is made when nothing is missing", async () => {
    const f = route((user) => ({ words: asked(user)!.map((w, i) => item(w, i, ["モデルの訳"])) }));
    const d = data(await gen(f, true));
    expect(f).toHaveBeenCalledTimes(1);
    expect(d.words.every((w) => w.ja!.join() === "モデルの訳")).toBe(true);
    const mixed = route((user, n) => (n === 0 ? { words: asked(user)!.map((w, i) => item(w, i, i === 0 ? ["机"] : undefined)) } : { ja: { ...JA, desk: ["WRONG"] } }));
    const m = data(await gen(mixed, true));
    expect(m.words[0].ja).toEqual(["机"]); // the model's own entry wins over the follow-up
    expect(m.words[1].ja).toEqual(["黒板"]);
  });
  it("if the follow-up fails, every word is still returned (no loss), the gap is reported, and nothing is invented", async () => {
    const f = route((user, n) => { if (n === 0) return { words: asked(user)!.map((w, i) => item(w, i)) }; throw new Error("boom"); });
    const d = data(await gen(f, true));
    expect(d.words.map((w) => w.word)).toEqual(CLASSROOM);
    expect(d.words.every((w) => !w.ja)).toBe(true);
    expect(d.issues.join(" ")).toMatch(/No Japanese meaning was written for: desk, blackboard/);
    const partial = route((user, n) => (n === 0 ? { words: asked(user)!.map((w, i) => item(w, i)) } : { ja: { desk: ["机"], wall: [] } }));
    const p = data(await gen(partial, true));
    expect(p.words.find((w) => w.word === "desk")!.ja).toEqual(["机"]);
    expect(p.words.find((w) => w.word === "wall")!.ja).toBeUndefined();
  });
  it("the follow-up is only on when asked for (the live route turns it on), so saved vocabulary is never touched", async () => {
    const f = route((user) => ({ words: asked(user)!.map((w, i) => item(w, i)) }));
    const d = data(await gen(f, false));
    expect(f).toHaveBeenCalledTimes(1);
    expect(d.words.every((w) => !w.ja)).toBe(true);
    expect(japanesePrompt([{ word: "desk", partOfSpeech: "noun", meaning: "m" }])[0].content).toMatch(/Never include merely related words/);
  });
});

describe("Japanese on the Study Page, end to end", () => {
  const full = (n: string, i: number, ja?: string[]) => ({ id: `w${i}`, ...item(n, i, ja) }) as unknown as VocabWord;
  it("the nine classroom words keep their Japanese from the approved set through storage, the class snapshot and the study page — with no hints", async () => {
    const store = memory();
    let a = createActivity("Classroom", "2026-04-01T00:00:00Z");
    a = addSet(a, CLASSROOM.map((w, i) => full(w, i, JA[w])), { requested: 9 });
    a = approveSet(a, a.sets[0].id).activity;
    saveActivity(store, a);
    const list = libraryLists(loadActivities(store).activities)[0];
    expect(list.count).toBe(9);
    expect(list.missingJapanese).toEqual([]);
    expect(list.words.map((w) => w.ja)).toEqual(CLASSROOM.map((w) => JA[w]));
    const svc = new ClassService(new MemoryKV());
    const c = await svc.createActivity({ title: list.title, words: list.words });
    if (!c.ok) throw new Error();
    const s = await svc.getStudy({ activityId: c.activity.id });
    if (!s.ok) throw new Error();
    expect(s.words.map((w) => [w.word, w.ja])).toEqual(CLASSROOM.map((w) => [w, JA[w]]));
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/hints|giverInfo|Teachers and students look/);
    const html = renderToStaticMarkup(h(StudyList, { title: "Classroom", words: s.words }));
    for (const w of CLASSROOM) expect(html).toContain(`>${w}<`);
    // students start with English only: the Japanese is in the data but not on the page until they ask
    expect(html).not.toContain("机");
    expect(html).not.toContain("掲示板");
    expect((html.match(/>Show Japanese</g) ?? []).length).toBe(9);
    expect(html).not.toContain("Japanese not added yet");
    expect(html).toContain("Show All Japanese");
    expect(html).toContain("Hide All Japanese");
  });
  it("Show/Hide: hidden mode shows a button instead of the Japanese; a missing translation is stated in both modes", () => {
    const shown = renderToStaticMarkup(h(StudyJapanese, { ja: ["机"], hidden: false }));
    expect(shown).toContain("机");
    expect(shown).toContain("Hide Japanese");
    expect(shown).not.toContain("Show Japanese");
    const hidden = renderToStaticMarkup(h(StudyJapanese, { ja: ["机"], hidden: true }));
    expect(hidden).not.toContain("机");
    expect(hidden).toContain("Show Japanese");
    for (const hide of [false, true]) {
      const missing = renderToStaticMarkup(h(StudyJapanese, { ja: [], hidden: hide }));
      expect(missing).toContain("Japanese not added yet");
      expect(missing).not.toContain("Show Japanese");
    }
  });
  it("the page tells students how many words lack Japanese, and still offers the Show/Hide All controls", () => {
    const words = [{ word: "desk", partOfSpeech: "noun", meaning: "m", ja: ["机"], example: "" }, { word: "wall", partOfSpeech: "noun", meaning: "m", ja: [], example: "" }];
    const html = renderToStaticMarkup(h(StudyList, { title: "T", words }));
    expect(html).toContain("Japanese isn&#x27;t available yet for 1 word.");
    expect(html).toContain("Japanese not added yet");
    expect(html).toContain("Hide All Japanese");
  });
  it("existing saved lists without Japanese are NOT filled in: they show 'not added yet' and are flagged to the teacher", async () => {
    const store = memory();
    let a = createActivity("Old classroom", "2026-01-01T00:00:00Z");
    a = addSet(a, CLASSROOM.slice(0, 3).map((w, i) => full(w, i)), { requested: 3 });
    a = approveSet(a, a.sets[0].id).activity;
    store.setItem(STORAGE_KEY, JSON.stringify([a]));
    const before = store.getItem(STORAGE_KEY);
    const list = libraryLists(loadActivities(store).activities)[0];
    expect(list.missingJapanese).toEqual(["desk", "blackboard", "screen"]);
    expect(list.words.every((w) => !w.ja)).toBe(true);
    expect(store.getItem(STORAGE_KEY)).toBe(before); // reading changed nothing
    const svc = new ClassService(new MemoryKV());
    const c = await svc.createActivity({ title: "Old", words: list.words });
    if (!c.ok) throw new Error();
    const s = await svc.getStudy({ activityId: c.activity.id });
    expect(s.ok && s.words.every((w) => w.ja.length === 0)).toBe(true);
  });
  it("the teacher can add or correct Japanese by hand, and it persists (saved, reloaded, hosted, studied)", async () => {
    const { updateWord, reopenSet } = await import("./ops");
    const store = memory();
    let a = createActivity("Old classroom", "2026-01-01T00:00:00Z");
    a = addSet(a, CLASSROOM.slice(0, 2).map((w, i) => full(w, i)), { requested: 2 });
    a = approveSet(a, a.sets[0].id).activity;
    a = reopenSet(a, a.sets[0].id); // explicit, as in the Studio
    a = updateWord(a, a.sets[0].id, a.sets[0].words[0].id, { ja: ["机", "デスク"] });
    a = approveSet(a, a.sets[0].id).activity;
    saveActivity(store, a);
    const list = libraryLists(loadActivities(store).activities)[0];
    expect(list.words[0].ja).toEqual(["机", "デスク"]);
    expect(list.missingJapanese).toEqual(["blackboard"]);
    const svc = new ClassService(new MemoryKV());
    const c = await svc.createActivity({ title: list.title, words: list.words });
    if (!c.ok) throw new Error();
    const s = await svc.getStudy({ activityId: c.activity.id });
    expect(s.ok && s.words.map((w) => w.ja)).toEqual([["机", "デスク"], []]);
  });
});

describe("Japanese answer scoring is unchanged", () => {
  it("only the teacher-approved list scores; a word with no list gives no Japanese credit; nothing from the study page is added", () => {
    const w = full();
    function full() {
      return { ...(item("desk", 0, ["机", "デスク"]) as unknown as VocabWord), id: "d" };
    }
    expect(checkJapaneseAnswer("机", w.ja)).toBe("correct");
    expect(checkJapaneseAnswer("デスク", w.ja)).toBe("correct");
    expect(checkJapaneseAnswer("黒板", w.ja)).toBe("wrong");
    expect(checkJapaneseAnswer("机", undefined)).toBe("unavailable");
    const state = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words: [w] });
    const round = gameReducer(gameReducer(state, { type: "CONTINUE" }), { type: "PICK", wordId: "d" });
    expect(gameReducer(round, { type: "GUESS_JA", text: "机" }).lastResult).toMatchObject({ outcome: "solved", answeredIn: "ja", takerPoints: 50, giverPoints: 25 });
    expect(gameReducer(round, { type: "GUESS_JA", text: "黒板" }).lastResult).toBeNull();
  });
});

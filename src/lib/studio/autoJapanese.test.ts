import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VocabWord } from "@/data/vocab";
import { StudyList } from "@/components/study/StudyList";
import { ClassService, MAX_STUDY_TRANSLATE_TRIES, STUDY_TRANSLATE_COOLDOWN, type StudyTranslator } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { checkJapaneseAnswer } from "@/lib/japanese";
import { createInitialState, gameReducer } from "@/lib/game";
import { handleStudioRequest } from "./ai/service";
import { parseStudioRequest } from "./ai/parse";
import { applyStudyJapanese, autoFillStudyJapanese, missingStudyJapanese, RETRY_AFTER_MS, TRIED_KEY } from "./autoJapanese";
import { libraryLists } from "./library";
import { addSet, approveSet, createActivity, reopenSet, updateWord } from "./ops";
import { loadActivities, saveActivity, STORAGE_KEY, type StorageLike } from "./storage";
import { EMPTY_BRIEF } from "./types";

const CLASSROOM = ["desk", "blackboard", "screen", "wall", "window", "bulletin board", "projector", "highlighter", "locker"];
const JA: Record<string, string[]> = {
  desk: ["机", "デスク"], blackboard: ["黒板"], screen: ["スクリーン", "画面"], wall: ["壁"], window: ["窓"],
  "bulletin board": ["掲示板"], projector: ["プロジェクター"], highlighter: ["蛍光ペン"], locker: ["ロッカー"],
};
const norm = (w: string) => w.toLowerCase();
const table = (words: string[]) => Object.fromEntries(words.filter((w) => JA[w]).map((w) => [norm(w), JA[w]]));
const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };
const word = (n: string, i: number, over: Partial<VocabWord> = {}): VocabWord => ({
  id: `w${i}`, word: n, accept: [], partOfSpeech: "noun", category: "Classroom", cefr: "A2", meaning: `a classroom thing: ${n}`, example: `We use the ${n} in class.`,
  hints: [`SECRET-HINT-${i} you notice it when you walk in.`, "Teachers and students look at it every day.", "It has a clear job in a school room."], ...over,
});
/** An old approved set: the first three words have teacher-approved Japanese answers, the rest have none. */
function oldActivity() {
  let a = createActivity("Classroom", "2026-03-01T00:00:00.000Z");
  a = addSet(a, CLASSROOM.map((w, i) => word(w, i, i < 3 ? { ja: JA[w] } : {})), { requested: 9 });
  a = approveSet(a, a.sets[0].id).activity;
  return a;
}
const seed = (s: StorageLike, ...acts: ReturnType<typeof oldActivity>[]) => s.setItem(STORAGE_KEY, JSON.stringify(acts));

describe("existing saved vocabulary: missing Japanese is detected and filled automatically", () => {
  it("finds exactly the approved words that have no Japanese at all (not drafts, not words with answers)", () => {
    const a = oldActivity();
    const draft = addSet(createActivity("Draft", "2026-03-02T00:00:00.000Z"), [word("chalk", 20)], { requested: 1 });
    expect(missingStudyJapanese([a, draft]).map((w) => w.word)).toEqual(["wall", "window", "bulletin board", "projector", "highlighter", "locker"]);
  });
  it("fills only the missing words, into the separate study field, leaving everything else exactly as saved", async () => {
    const s = memory();
    const a = oldActivity();
    seed(s, a);
    const before = loadActivities(s).activities[0];
    const translate = vi.fn(async (words: { word: string }[]) => table(words.map((w) => w.word)));
    const r = await autoFillStudyJapanese(s, translate, 1_000);
    expect(r).toEqual({ requested: 6, filled: 6 });
    expect(translate).toHaveBeenCalledTimes(1); // one request for all six words
    expect(translate.mock.calls[0][0].map((w) => w.word)).toEqual(["wall", "window", "bulletin board", "projector", "highlighter", "locker"]);
    const after = loadActivities(s).activities[0];
    const [bs, as] = [before.sets[0], after.sets[0]];
    expect(as.status).toBe("approved"); // no reopening, no re-approval
    expect(after.updatedAt).toBe(before.updatedAt);
    for (let i = 0; i < 9; i++) {
      const { studyJa, ...rest } = as.words[i];
      expect(rest).toEqual(bs.words[i]); // definition, example, hints, answers, ids: identical
      if (i < 3) expect(studyJa).toBeUndefined(); // existing Japanese is never overwritten or duplicated
      else expect(studyJa).toEqual(JA[CLASSROOM[i]]);
    }
    expect(as.words.slice(0, 3).map((w) => w.ja)).toEqual([JA.desk, JA.blackboard, JA.screen]);
    expect(as.words.slice(3).every((w) => w.ja === undefined)).toBe(true); // scoring answers stay empty
  });
  it("teacher edits are preserved: a word the teacher already gave Japanese (or a study meaning) is never replaced", () => {
    const s = memory();
    let a = oldActivity();
    a = reopenSet(a, a.sets[0].id);
    a = updateWord(a, a.sets[0].id, a.sets[0].words[3].id, { studyJa: ["教師の訳"] }); // teacher corrected "wall"
    a = approveSet(a, a.sets[0].id).activity;
    seed(s, a);
    expect(missingStudyJapanese(loadActivities(s).activities).map((w) => w.word)).not.toContain("wall");
    expect(applyStudyJapanese(s, table(CLASSROOM))).toBe(5); // window … locker only
    expect(loadActivities(s).activities[0].sets[0].words[3].studyJa).toEqual(["教師の訳"]);
  });
  it("a word with no translation stays plainly missing — nothing is invented", async () => {
    const s = memory();
    seed(s, oldActivity());
    const r = await autoFillStudyJapanese(s, async () => ({ wall: JA.wall }), 1_000);
    expect(r.filled).toBe(1);
    const lists = libraryLists(loadActivities(s).activities);
    expect(lists[0].missingJapanese).toEqual(["window", "bulletin board", "projector", "highlighter", "locker"]);
  });
  it("AI calls are bounded: asked once per word per day, a failure is not retried on every visit, nothing missing → no call", async () => {
    const s = memory();
    seed(s, oldActivity());
    const failing = vi.fn(async () => { throw new Error("boom"); });
    expect(await autoFillStudyJapanese(s, failing, 1_000)).toEqual({ requested: 6, filled: 0 });
    expect(await autoFillStudyJapanese(s, failing, 2_000)).toEqual({ requested: 0, filled: 0 }); // same day: not asked again
    expect(failing).toHaveBeenCalledTimes(1);
    const ok = vi.fn(async (w: { word: string }[]) => table(w.map((x) => x.word)));
    expect((await autoFillStudyJapanese(s, ok, 1_000 + RETRY_AFTER_MS + 1)).filled).toBe(6); // a day later it tries again
    expect(await autoFillStudyJapanese(s, ok, 1_000 + 2 * RETRY_AFTER_MS)).toEqual({ requested: 0, filled: 0 }); // nothing left to ask
    expect(ok).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.getItem(TRIED_KEY)!)).toHaveProperty("wall");
    // a very long list is capped per request
    const big = memory();
    let a = createActivity("Big", "2026-03-01T00:00:00.000Z");
    a = addSet(a, Array.from({ length: 10 }, (_, i) => word(`word${i}`, i)), { requested: 10 });
    for (let k = 0; k < 3; k++) a = addSet(a, Array.from({ length: 10 }, (_, i) => word(`more${k}x${i}`, 100 + k * 10 + i)), { requested: 10 });
    for (const set of a.sets) a = approveSet(a, set.id).activity;
    seed(big, a);
    const spy = vi.fn(async () => ({}));
    const r = await autoFillStudyJapanese(big, spy, 5);
    expect(r.requested).toBe(30);
  });
});

describe("the AI service task and the request parser", () => {
  it("fill-japanese translates only the words sent, keyed by the normalised word; the demo AI offers nothing", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ja: JA }) } }] }), { status: 200 }));
    const r = await handleStudioRequest({ task: "fill-japanese", brief: EMPTY_BRIEF, words: [{ word: "Desk", partOfSpeech: "noun", meaning: "m" }, { word: "bulletin board", partOfSpeech: "noun", meaning: "m" }] }, { apiKey: "k", model: "m", fetchImpl: f as never });
    expect(r.body.ok && r.body.data).toEqual({ task: "fill-japanese", ja: { desk: JA.desk, "bulletin board": JA["bulletin board"] } });
    expect(f).toHaveBeenCalledTimes(1);
    const mock = await handleStudioRequest({ task: "fill-japanese", brief: EMPTY_BRIEF, words: [{ word: "desk", partOfSpeech: "noun", meaning: "m" }] }, {});
    expect(mock.body.ok && mock.body.data).toEqual({ task: "fill-japanese", ja: {} });
    expect(() => parseStudioRequest({ task: "fill-japanese", brief: {}, words: [] })).toThrow();
  });
});

describe("old classroom snapshots are repaired on the first study visit, once, without touching games or scores", () => {
  async function env(translator?: StudyTranslator, withJa = false) {
    let now = 1_000_000;
    const kv = new MemoryKV(() => now);
    const svc = new ClassService(kv, () => now, { translator });
    const created = await svc.createActivity({ title: "Classroom — Set 1", words: CLASSROOM.map((w, i) => word(w, i, withJa && i < 3 ? { ja: JA[w] } : {})) });
    if (!created.ok) throw new Error();
    return { kv, svc, activity: created.activity, advance: (ms: number) => { now += ms; } };
  }
  const studyOf = async (svc: ClassService, id: string) => { const r = await svc.getStudy({ activityId: id }); if (!r.ok) throw new Error(JSON.stringify(r)); return r; };

  it("supplies the missing Japanese automatically for the nine classroom words, then serves it from cache (no repeat calls)", async () => {
    const translator = vi.fn<StudyTranslator>(async (w) => table(w.map((x) => x.word)));
    const e = await env(translator);
    const first = await studyOf(e.svc, e.activity.id);
    expect(first.words.map((w) => [w.word, w.ja])).toEqual(CLASSROOM.map((w) => [w, JA[w]]));
    expect(first.translating).toBe(false);
    expect(translator).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await studyOf(e.svc, e.activity.id); // students keep opening the page
    expect(translator).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toMatch(/SECRET|hints/);
  });
  it("existing Japanese is never overwritten, and words that already have it are not even sent to the AI", async () => {
    const translator = vi.fn<StudyTranslator>(async (w) => ({ ...table(w.map((x) => x.word)), desk: ["WRONG"] }));
    const e = await env(translator, true);
    const s = await studyOf(e.svc, e.activity.id);
    expect(translator.mock.calls[0][0].map((w) => w.word)).toEqual(CLASSROOM.slice(3));
    expect(s.words[0].ja).toEqual(JA.desk);
    expect(s.words[3].ja).toEqual(JA.wall);
  });
  it("the activity snapshot, active games and scores are untouched by the repair (translations live in their own cache)", async () => {
    const e = await env(async (w) => table(w.map((x) => x.word)));
    const a = { activityId: e.activity.id, group: "4" }, tokens: Record<string, string> = {};
    for (const name of ["Aki", "Ben"]) { const r = await e.svc.join({ ...a, name }); if (!r.ok) throw new Error(); tokens[name] = r.token; }
    await e.svc.act({ ...a, token: tokens.Aki, action: { type: "PROPOSE_ROLES", giver: "me" } });
    await e.svc.act({ ...a, token: tokens.Ben, action: { type: "CONFIRM_ROLES" } });
    const roomBefore = await e.kv.get(`vqs:room:${e.activity.id}:4`);
    const snapshotBefore = await e.kv.get(`vqs:act:${e.activity.id}`);
    await studyOf(e.svc, e.activity.id); // anonymous visitor triggers the repair
    expect(await e.kv.get(`vqs:room:${e.activity.id}:4`)).toBe(roomBefore); // the live game is byte-identical
    expect(await e.kv.get(`vqs:act:${e.activity.id}`)).toBe(snapshotBefore);
    // the pair keeps playing and the Japanese answers still do not score (there are none on file for this word)
    const view = await e.svc.getView({ ...a, token: tokens.Aki });
    expect(view.ok && !view.unchanged && view.view.game!.words.every((w) => w.studyJa === undefined && !(w.ja ?? []).some(Boolean))).toBe(true);
  });
  it("cost control: one request at a time, a cool-down after a failure, and a hard cap on total attempts", async () => {
    // simultaneous first visitors: one translates, the other is told it is being prepared
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.fn<StudyTranslator>(async (w) => { await gate; return table(w.map((x) => x.word)); });
    const e = await env(slow);
    const p1 = e.svc.getStudy({ activityId: e.activity.id });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    const p2 = await e.svc.getStudy({ activityId: e.activity.id });
    expect(p2.ok && p2.translating).toBe(true);
    release();
    const r1 = await p1;
    expect(r1.ok && r1.words.every((w) => w.ja.length > 0)).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);

    // failures: not retried on every visit; retried after the cool-down; never more than the cap
    const failing = vi.fn<StudyTranslator>(async () => { throw new Error("no"); });
    const f = await env(failing);
    for (let i = 0; i < 4; i++) await studyOf(f.svc, f.activity.id);
    expect(failing).toHaveBeenCalledTimes(1);
    for (let k = 0; k < 6; k++) { f.advance((STUDY_TRANSLATE_COOLDOWN + 5) * 1000); await studyOf(f.svc, f.activity.id); }
    expect(failing).toHaveBeenCalledTimes(MAX_STUDY_TRANSLATE_TRIES);
    const page = await studyOf(f.svc, f.activity.id);
    expect(page.words.every((w) => w.ja.length === 0)).toBe(true); // nothing invented
  });
  it("with no AI configured nothing is called and the words are simply shown as 'not added yet'", async () => {
    const e = await env(undefined);
    const s = await studyOf(e.svc, e.activity.id);
    expect(s.words.every((w) => w.ja.length === 0)).toBe(true);
    expect(s.translating).toBe(false);
  });
});

describe("scoring is unchanged: study translations are never answers", () => {
  it("studyJa is ignored by Japanese answer checking, and is stripped when a class game starts", async () => {
    const w = { ...word("desk", 0), studyJa: ["机"] };
    expect(checkJapaneseAnswer("机", w.ja)).toBe("unavailable"); // no approved answers → no Japanese credit, as before
    const kv = new MemoryKV();
    const svc = new ClassService(kv);
    const c = await svc.createActivity({ title: "T", words: [w] });
    if (!c.ok) throw new Error();
    expect(c.activity.words[0].studyJa).toEqual(["机"]); // kept in the snapshot for the study page
    const a = { activityId: c.activity.id, group: "1" };
    const t1 = await svc.join({ ...a, name: "Aki" }), t2 = await svc.join({ ...a, name: "Ben" });
    if (!t1.ok || !t2.ok) throw new Error();
    await svc.act({ ...a, token: t1.token, action: { type: "PROPOSE_ROLES", giver: "me" } });
    await svc.act({ ...a, token: t2.token, action: { type: "CONFIRM_ROLES" } });
    const room = JSON.parse((await kv.get(`vqs:room:${c.activity.id}:1`))!.split("|").slice(1).join("|")) as { game: { words: VocabWord[] } };
    expect(room.game.words[0].studyJa).toBeUndefined();
    expect(JSON.stringify(room.game)).not.toContain("机");
  });
  it("answering with the study meaning earns nothing; answering with an approved answer earns the usual half points", () => {
    const w = { ...word("desk", 0, { ja: ["机"] }), studyJa: ["勉強机"] };
    const state = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words: [w] });
    const round = gameReducer(gameReducer(state, { type: "CONTINUE" }), { type: "PICK", wordId: "w0" });
    expect(gameReducer(round, { type: "GUESS_JA", text: "勉強机" }).lastResult).toBeNull();
    expect(gameReducer(round, { type: "GUESS_JA", text: "机" }).lastResult).toMatchObject({ outcome: "solved", answeredIn: "ja", takerPoints: 50, giverPoints: 25 });
  });
});

describe("the study page starts with English only", () => {
  const words = CLASSROOM.map((w) => ({ word: w, partOfSpeech: "noun", meaning: `meaning of ${w}`, ja: JA[w], example: `We use the ${w}.` }));
  it("shows definitions, examples and pronunciation but no Japanese on load; every word has its own Show button, plus Show All / Hide All", () => {
    const html = renderToStaticMarkup(h(StudyList, { title: "Classroom — Set 1", words }));
    for (const w of CLASSROOM) {
      expect(html).toContain(`meaning of ${w}`);
      expect(html).toContain(`We use the ${w}.`);
      expect(html).toContain(`Hear the word ${w}`);
      for (const ja of JA[w]) expect(html).not.toContain(ja);
    }
    expect((html.match(/>Show Japanese</g) ?? []).length).toBe(9);
    expect(html).toContain("Show All Japanese");
    expect(html).toContain("Hide All Japanese");
    expect(html).not.toContain(">Hide Japanese<"); // nothing is revealed, so no per-word Hide yet
  });
  it("a translation being prepared is described as such, not as missing for good", () => {
    const html = renderToStaticMarkup(h(StudyList, { title: "T", words: [{ ...words[0], ja: [] }], pending: true }));
    expect(html).toContain("Japanese is being prepared");
  });
});

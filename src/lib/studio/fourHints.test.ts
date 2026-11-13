import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GiverRound } from "@/components/GiverRound";
import { TakerRound } from "@/components/TakerRound";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createInitialState, gameReducer, redactForTaker, type GameState } from "@/lib/game";
import { pointsForHints } from "@/lib/scoring";
import { bankFromText, convertBank, filterBank, loadBank, pickForGame } from "./cqsBank";
import { convertQuestion } from "./cqsImport";
import type { StorageLike } from "./storage";
import { applyAiHints, createActivity, createSet } from "./ops";
import { coerceWord, leaksTarget, validateWord } from "./validation";

/** The bones question as it is in the Classroom Quiz Show bank (clue 1 hardest … clue 4 decisive). */
const bones = (over: Record<string, unknown> = {}) => ({
  id: "bank-a2-bones", cefrLevel: "A2", categoryId: "health", categoryName: "Body & Health", prompt: "Which part of the body is this?",
  chunks: ["Adults have 206 of them.", "The smallest one is inside your ear.", "Calcium from milk helps keep them strong.", "Together, they make your skeleton."],
  choices: ["bones", "muscles", "nerves", "veins"], correctIndex: 0, answer: "bones", status: "approved", ...over,
});
/** The hints in the source order: clue 1 (hardest to guess) is the free opening hint, clue 4 (the most decisive) is the last paid hint. */
const CLUES = ["Adults have 206 of them.", "The smallest one is inside your ear.", "Calcium from milk helps keep them strong.", "Together, they make your skeleton."];
const memory = (): StorageLike & { data: Record<string, string> } => { const data: Record<string, string> = {}; return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } }; };

describe("four hints: conversion", () => {
  it("bones keeps all four clues in the source order: free opening hint, then three paid hints, each more helpful", () => {
    const item = convertQuestion(bones());
    expect(item.status).toBe("ready");
    expect(item.word!.hints).toEqual(CLUES);
    expect(item.notes).toEqual([]);
    expect(item.word).toMatchObject({ word: "bones", cefr: "A2", category: "Body & Health", source: "classroom-quiz-show" });
  });
  it("no hint contains the target word, and the word passes the app's own validation", () => {
    const w = convertQuestion(bones()).word!;
    for (const x of w.hints) expect(leaksTarget(w, x)).toBe(false);
    expect(validateWord(w).filter((i) => i.severity === "error")).toEqual([]);
  });
  it("a clue that gives the answer away is left out, NOT replaced: the word is flagged with three hints", () => {
    const item = convertQuestion(bones({ chunks: ["Adults have 206 of them.", "The smallest one is inside your ear.", "These bones are strong.", "Together, they make your skeleton."] }));
    expect(item.status).toBe("flagged");
    expect(item.word!.hints).toEqual([CLUES[0], CLUES[1], CLUES[3]]); // the other three stay in their source order
    expect(item.word!.hints).not.toContain("These bones are strong.");
    expect(item.reasons.join(" ")).toMatch(/Only 3 of the 4 clues/);
    expect(item.notes.join(" ")).toMatch(/Clue 3 was left out because it contains the word/);
  });
  it("the progression is the source order, untouched: each later hint is the next clue, word for word", () => {
    // Representative questions from the bank, A1 to C1 (clue 1 = hardest to guess … clue 4 = easiest and most decisive).
    const samples: [string, string, string[]][] = [
      ["A1", "hello", ["In Japanese, you say 'konnichiwa'.", "On the phone, English speakers often say it first.", "You say it when you meet someone.", "It means the same as 'Hi'."]],
      ["A1", "dinosaurs", ["Their name means 'terrible lizard'.", "They lived millions of years ago.", "We know about them from their bones, called fossils.", "T. rex was one of them."]],
      ["A2", "lungs", ["Inside, they have millions of tiny air bags with a surface as big as half a tennis court.", "Smoking damages them.", "You have two of them in your chest.", "You use them to breathe air in and out."]],
      ["B1", "blood", ["An adult has about five litres of it.", "Its main types are A, B, AB and O.", "Red cells in it carry oxygen around the body.", "It is the red liquid that comes out when you cut yourself."]],
      ["B2", "Bluetooth", ["It is named after a 10th-century Danish king famous for uniting different groups.", "Its logo combines two ancient runes from his initials.", "It lets devices connect wirelessly over short distances.", "You use it to connect wireless earphones to your phone."]],
      ["C1", "Hamlet", ["Its hero pretends to be mad in order to discover the truth.", "He uses a play within the play to 'catch the conscience of the king'.", "The hero's dead father appears as a ghost.", "This Shakespeare tragedy contains the line 'To be, or not to be'."]],
    ];
    for (const [level, answer, chunks] of samples) {
      const item = convertQuestion(bones({ id: `s-${answer}`, cefrLevel: level, answer, choices: [answer, "x", "y", "z"], chunks }));
      if (/^[a-z]/.test(answer)) expect(item.status, answer).toBe("ready"); // proper names (Bluetooth, Hamlet) are flagged for spoken use, whatever their clues
      expect(item.word!.hints, answer).toEqual(chunks); // all four, same words, same order
      expect(item.word!.cefr).toBe(level);
    }
  });
  it("an empty or over-long clue is also left out and flagged, never invented", () => {
    const blank = convertQuestion(bones({ chunks: ["Adults have 206 of them.", "   ", "Calcium from milk helps keep them strong.", "Together, they make your skeleton."] }));
    expect(blank).toMatchObject({ status: "flagged" });
    expect(blank.word!.hints).toHaveLength(3);
    const long = convertQuestion(bones({ chunks: ["Adults have 206 of them.", "x ".repeat(150), "Calcium from milk helps keep them strong.", "Together, they make your skeleton."] }));
    expect(long.word!.hints).toHaveLength(3);
    expect(long.status).toBe("flagged");
  });
  it("fewer than three usable clues is skipped; nothing is made up to fill the gap", () => {
    const two = convertQuestion(bones({ chunks: ["Bones are hard.", "Adults have 206 bones.", "Calcium helps keep them strong.", "Together, they make your skeleton."] }));
    expect(two.status).toBe("skipped");
    expect(two.word).toBeUndefined();
  });
  it("other flags still apply to four-hint words (a person's name is flagged even with four clean clues)", () => {
    const item = convertQuestion(bones({ id: "p", prompt: "Who is this?", answer: "Franz Kafka", choices: ["Franz Kafka", "b", "c", "d"], chunks: ["He worked in an office.", "He lived in Prague.", "His stories are strange.", "He wrote about a man who turns into a bug."] }));
    expect(item.status).toBe("flagged");
    expect(item.word!.hints).toHaveLength(4);
  });
});

describe("four hints: what a saved or synced bank does", () => {
  it("a bank saved earlier is converted again every time it is used, so no new sync is needed", () => {
    // A saved bank holds the raw questions, not converted words: the same bytes give four hints now.
    const s = memory();
    const text = JSON.stringify({ format: "classroom-quiz-show/questions", version: 1, questions: [bones()] });
    bankFromText(s, "old.json", text);
    const saved = loadBank(s)!;
    expect(JSON.stringify(saved.questions)).not.toContain("hints");
    const report = convertBank(saved);
    expect(report.items[0].word!.hints).toEqual(CLUES);
    expect(report.counts).toMatchObject({ ready: 1, flagged: 0 });
  });
  it("a game picked from the bank carries four hints per ready word", () => {
    const qs = [bones(), bones({ id: "b2", answer: "muscles", choices: ["muscles", "b", "c", "d"], chunks: ["There are about 600 of them in your body.", "They pull on your bones.", "You use them to lift a bag.", "They make your body move."] })];
    const pool = filterBank(convertBank({ v: 1, fileName: "", exportedAt: "", savedAt: "", questions: qs }), { cefr: "all", category: "all" });
    const pick = pickForGame(pool, 10, new Set());
    expect(pick.words).toHaveLength(2); // both are ready, so both are picked
    expect(pick.words.every((w) => w.hints.length === 4)).toBe(true);
  });
});

describe("four hints: the data model", () => {
  const w = () => convertQuestion(bones()).word!;
  it("an imported word keeps four hints through saving and loading; every other word is still limited to three", () => {
    expect(coerceWord(w(), { id: "x" })).toMatchObject({ word: { hints: CLUES } });
    const ordinary = { ...w(), source: undefined, sourceId: undefined, meaning: "bones", example: "My bones hurt." };
    const c = coerceWord(ordinary);
    expect("word" in c && c.word.hints).toHaveLength(3);
    expect(validateWord({ ...(c as { word: ReturnType<typeof w> }).word, hints: CLUES }).some((i) => i.severity === "error" && i.field === "hints")).toBe(true); // ordinary words need exactly three
  });
  it("an imported word may have three or four hints, not two or five", () => {
    const base = w();
    const errs = (n: number) => validateWord({ ...base, hints: [...CLUES, "Extra clue number five here."].slice(0, n) }).filter((i) => i.field === "hints" && i.severity === "error");
    expect(errs(3)).toEqual([]);
    expect(errs(4)).toEqual([]);
    expect(errs(2)).not.toEqual([]);
    expect(errs(5)).not.toEqual([]);
  });
  it("rewriting hints with AI in Studio never drops or changes the fourth hint", () => {
    const base = w();
    const a = { ...createActivity("t"), sets: [createSet([base], "s")] };
    const r = applyAiHints(a, a.sets[0].id, base.id, ["New opening one here.", "New second hint here.", "New third hint here."]);
    expect(r.activity.sets[0].words[0].hints).toEqual(["New opening one here.", "New second hint here.", "New third hint here.", CLUES[3]]);
  });
});

describe("four hints: playing with them (classroom server)", () => {
  async function room() {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const word = { ...convertQuestion(bones()).word!, id: "k0" };
    const word2 = { ...convertQuestion(bones({ id: "q2", answer: "muscles", choices: ["muscles", "b", "c", "d"], chunks: ["There are about 600 of them in your body.", "They pull on your bones.", "You use them to lift a bag.", "They make your body move."] })).word!, id: "k1" };
    const created = await svc.createActivity({ title: "Four", words: [word, word2] });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    const join = async (name: string, token?: string) => { const r = await svc.join({ activityId: id, group: "3", name, token }); if (!r.ok) throw new Error("join"); return r; };
    const A = await join("Aki"), B = await join("Ben");
    const act = (t: string, action: object) => svc.act({ activityId: id, group: "3", token: t, opId: Math.random().toString(36), action: action as never });
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "3", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" });
    await act(B.token, { type: "CONFIRM_ROLES" });
    await act(A.token, { type: "CONTINUE" });
    await act(A.token, { type: "PICK", wordId: word.id });
    return { act, view, A, B, word, join, scores: async () => (await view(A.token)).game!.players.map((p) => p.score) };
  }
  type Room = Awaited<ReturnType<typeof room>>;
  const stage = async (e: Room, paid: number, takerSees: number) => {
    const g = (await e.view(e.A.token)).game!, t = (await e.view(e.B.token)).game!;
    expect(g.words[0].hints.slice(0, paid + 1)).toEqual(CLUES.slice(0, paid + 1)); // the Giver sees everything revealed so far
    expect(t.words[0].hints).toEqual(CLUES.map((c, i) => (i < takerSees ? c : ""))); // the Taker: only EARLIER hints
    const raw = [JSON.stringify(await e.view(e.B.token)), JSON.stringify((await e.join("Ben", e.B.token)).view)];
    CLUES.forEach((c, i) => raw.forEach((p) => (i < takerSees ? expect(p).toContain(c) : expect(p, `hint ${i + 1} must not be in the Taker's response`).not.toContain(c))));
    raw.forEach((p) => expect(p).not.toContain('"bones"'));
    expect(t).toMatchObject({ revealedHints: paid + 1, hintsUsed: paid });
  };

  it("all three paid hints can be revealed, and the Taker is always one hint behind", async () => {
    const e = await room();
    await stage(e, 0, 0); // opening only: the Taker sees no written hint
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await stage(e, 1, 1); // opening hint shown, the hint just revealed is not
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await stage(e, 2, 2);
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await stage(e, 3, 3); // all three paid hints revealed; the newest (the fourth hint) is still withheld
    await e.act(e.A.token, { type: "REVEAL_HINT" }); // no fourth paid hint exists
    await stage(e, 3, 3);
  });
  it("round completion shows all four hints and the next word starts fresh", async () => {
    const e = await room();
    for (let i = 0; i < 3; i++) await e.act(e.A.token, { type: "REVEAL_HINT" });
    await e.act(e.B.token, { type: "GUESS", text: "bones" });
    const t = (await e.view(e.B.token)).game!;
    expect(t.phase).toBe("reveal");
    expect(t.words[0].hints).toEqual(CLUES);
    await e.act(e.A.token, { type: "NEXT" });
    await e.act(e.B.token, { type: "CONTINUE" });
    await e.act(e.B.token, { type: "PICK", wordId: "k1" });
    expect((await e.view(e.A.token)).game!.words[1].hints).toEqual(["", "", "", ""]);
  });
  it("scoring is unchanged: 100, 85, 70, 55 for 0–3 paid hints, a 25-point minimum, Giver half", async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(pointsForHints)).toEqual([100, 85, 70, 55, 40, 25, 25, 25]);
    for (const [paid, taker, giver] of [[0, 100, 50], [1, 85, 43], [2, 70, 35], [3, 55, 28]] as const) {
      const e = await room();
      for (let i = 0; i < paid; i++) await e.act(e.A.token, { type: "REVEAL_HINT" });
      await e.act(e.B.token, { type: "GUESS", text: "bones" });
      expect(await e.scores()).toEqual([giver, taker]);
    }
    const floor = await room();
    for (let i = 0; i < 3; i++) await floor.act(floor.A.token, { type: "REVEAL_HINT" });
    for (let i = 0; i < 4; i++) await floor.act(floor.A.token, { type: "ADJUST_HINTS", delta: 1 }); // spoken hints still count: 3 + 4 = 7 hints
    await floor.act(floor.B.token, { type: "GUESS", text: "bones" });
    expect(await floor.scores()).toEqual([13, 25]);
  });
  it("spoken hints and Undo never change what the Taker can read", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "ADJUST_HINTS", delta: 1 });
    expect((await e.view(e.B.token)).game!.words[0].hints).toEqual(["", "", "", ""]);
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    expect((await e.view(e.B.token)).game!.words[0].hints).toEqual([CLUES[0], CLUES[1], "", ""]);
    await e.act(e.A.token, { type: "ADJUST_HINTS", delta: -1 });
    expect((await e.view(e.B.token)).game!.words[0].hints).toEqual([CLUES[0], CLUES[1], "", ""]);
  });
});

describe("four hints: the screens", () => {
  const start = (): GameState => {
    const w = convertQuestion(bones()).word!;
    let s = gameReducer(createInitialState(), { type: "START", names: ["Aki", "Ben"], words: [w] });
    s = gameReducer(s, { type: "CONTINUE" });
    return gameReducer(s, { type: "PICK", wordId: w.id });
  };
  const giver = (s: GameState) => renderToStaticMarkup(h(GiverRound, { state: s, dispatch: () => undefined }));
  const taker = (s: GameState) => renderToStaticMarkup(h(TakerRound, { state: redactForTaker(s), dispatch: () => undefined }));
  it("the Giver can reveal hints 2, 3 and 4; after the third paid hint it says all are used", () => {
    let s = start();
    expect(giver(s)).toContain("Reveal Next Hint");
    expect(giver(s)).not.toContain("All prepared hints are used");
    for (let i = 1; i <= 3; i++) {
      s = gameReducer(s, { type: "REVEAL_HINT" });
      const html = giver(s);
      for (const c of CLUES.slice(0, i + 1)) expect(html).toContain(c.replace(/'/g, "&#x27;"));
      expect(html.includes("Reveal Next Hint")).toBe(i < 3);
    }
    expect(giver(s)).toContain("All prepared hints are used");
    expect(s.hintsUsed).toBe(3);
  });
  it("the Taker's screen shows only earlier hints at each stage", () => {
    let s = start();
    expect(taker(s)).not.toContain("Hint 1");
    const seen = (html: string) => CLUES.map((c) => html.includes(c));
    s = gameReducer(s, { type: "REVEAL_HINT" });
    expect(seen(taker(s))).toEqual([true, false, false, false]);
    s = gameReducer(s, { type: "REVEAL_HINT" });
    expect(seen(taker(s))).toEqual([true, true, false, false]);
    s = gameReducer(s, { type: "REVEAL_HINT" });
    expect(seen(taker(s))).toEqual([true, true, true, false]);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
const REAL = `${homedir()}/Downloads/quiz-bank-2026-11-12-424-questions.json`;
describe.runIf(existsSync(REAL))("the real export: hints are the source clues, in order, never rewritten (read only)", () => {
  it("every converted word's hints are a word-for-word, in-order selection of its four source clues", () => {
    const qs = (JSON.parse(readFileSync(REAL, "utf8")) as { questions: { id: string; chunks: string[] }[] }).questions;
    const bySource = new Map(qs.map((q) => [q.id, q.chunks.map((c) => c.replace(/\s+/g, " ").trim())]));
    const report = convertBank({ v: 1, fileName: "", exportedAt: "", savedAt: "", questions: qs });
    let checked = 0, four = 0;
    for (const i of report.items) {
      if (!i.word) continue;
      const src = bySource.get(i.sourceId)!;
      const idx = i.word.hints.map((hint) => src.indexOf(hint));
      expect(idx.every((n) => n >= 0), `${i.label}: a hint is not one of its source clues`).toBe(true); // nothing invented or rewritten
      expect(idx, `${i.label}: hints must keep the source order`).toEqual([...idx].sort((a, b) => a - b));
      if (i.word.hints.length === 4) { four++; expect(i.word.hints).toEqual(src); }
      else expect(i.status).toBe("flagged"); // fewer than four means a clue had to be left out: flagged for review
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
    expect(four).toBeGreaterThan(250);
  });
});

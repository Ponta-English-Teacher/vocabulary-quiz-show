import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createClassLink } from "@/lib/class/createLink";
import { leaksTarget } from "./validation";
import { bankCategories, bankFromText, bankLevels, BANK_KEY, clearBank, convertBank, filterBank, loadBank, MAX_GAME_WORDS, pickForGame, shuffle } from "./cqsBank";
import { loadActivities, saveActivity, type StorageLike } from "./storage";
import { createActivity } from "./ops";

const memory = (): StorageLike & { data: Record<string, string>; removeItem(k: string): void } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
};
let n = 0;
const question = (over: Record<string, unknown> = {}) => {
  const name = `fruit${[...String(n++)].map((d) => String.fromCharCode(97 + Number(d))).join("")}`;
  return {
    id: `q${n}`, cefrLevel: "A1", categoryId: "food", categoryName: "Food & Drink", prompt: "What food is this?",
    chunks: [`Clue four for ${n} is hard.`, `People eat it at lunch number ${n}.`, `It is a tasty snack that kids like ${n}.`, `It is a sweet food from a shop ${n}.`],
    choices: [name, "b", "c", "d"], correctIndex: 0, answer: name, status: "approved", tags: ["x"], lastReview: { note: "dropped" }, ...over,
  };
};
const exportText = (qs: unknown[]) => JSON.stringify({ format: "classroom-quiz-show/questions", version: 1, exportedAt: "2026-11-12T00:00:00Z", count: qs.length, questions: qs });
const flaggedQ = (over = {}) => question({ prompt: "Who is this?", categoryName: "Arts & Literature", categoryId: "arts", cefrLevel: "B2", ...over });

describe("remembering the bank in this browser", () => {
  it("saves a bank, reloads it, and keeps only the fields the converter needs", () => {
    const s = memory();
    const r = bankFromText(s, "bank.json", exportText([question(), question()]));
    expect(r).toMatchObject({ ok: true, remembered: true });
    const saved = loadBank(s)!;
    expect(saved.fileName).toBe("bank.json");
    expect(saved.questions).toHaveLength(2);
    expect(Object.keys(saved.questions[0] as object)).not.toContain("lastReview");
    expect(convertBank(saved).counts.ready).toBe(2);
  });
  it("a bad replacement file is refused and the previous bank stays", () => {
    const s = memory();
    bankFromText(s, "old.json", exportText([question()]));
    const r = bankFromText(s, "bad.json", "not json");
    expect(r.ok).toBe(false);
    expect(loadBank(s)!.fileName).toBe("old.json");
    expect(bankFromText(s, "v2.json", JSON.stringify({ format: "classroom-quiz-show/questions", version: 2, questions: [] })).ok).toBe(false);
    expect(loadBank(s)!.fileName).toBe("old.json");
  });
  it("a good replacement file replaces the bank; removing it forgets the bank without touching saved activities", () => {
    const s = memory();
    saveActivity(s, createActivity("Old Studio activity"));
    const activitiesBefore = s.data["vqs.activities.v1"];
    bankFromText(s, "one.json", exportText([question()]));
    bankFromText(s, "two.json", exportText([question(), question(), question()]));
    expect(loadBank(s)!.fileName).toBe("two.json");
    expect(loadBank(s)!.questions).toHaveLength(3);
    clearBank(s);
    expect(loadBank(s)).toBeNull();
    expect(s.data[BANK_KEY]).toBeUndefined();
    expect(s.data["vqs.activities.v1"]).toBe(activitiesBefore); // bank storage is separate from saved activities
    expect(loadActivities(s).activities).toHaveLength(1);
  });
  it("still works for this visit when the browser will not store it", () => {
    const blocked: StorageLike = { getItem: () => null, setItem: () => { throw new Error("full"); } };
    expect(bankFromText(blocked, "b.json", exportText([question()]))).toMatchObject({ ok: true, remembered: false });
    expect(loadBank(null)).toBeNull();
  });
});

describe("filters and selection", () => {
  const bank = () => {
    const qs = [question(), question(), question(), question({ cefrLevel: "A2" }), question({ cefrLevel: "A2", categoryName: "Animals", categoryId: "animals", prompt: "Which animal is this?" }), flaggedQ(), flaggedQ({ cefrLevel: "A1", categoryName: "Food & Drink", categoryId: "food" }), question({ status: "archived" })];
    return convertBank(bankFromText(null, "b", exportText(qs)).ok ? { v: 1, fileName: "b", exportedAt: "", savedAt: "", questions: qs } : (null as never));
  };
  it("counts ready, flagged and skipped and lists the levels and categories", () => {
    const r = bank();
    expect(r.counts).toMatchObject({ total: 8, ready: 5, flagged: 2, skipped: 1 });
    expect(bankLevels(r)).toEqual(["A1", "A2", "B2"]);
    expect(bankCategories(r)).toEqual(["Animals", "Arts & Literature", "Food & Drink"]);
  });
  it("filters by level and category", () => {
    const r = bank();
    expect(filterBank(r, { cefr: "A1", category: "Food & Drink" })).toMatchObject({ ready: expect.any(Array) });
    expect(filterBank(r, { cefr: "A1", category: "Food & Drink" }).ready).toHaveLength(3);
    expect(filterBank(r, { cefr: "A2", category: "all" }).ready).toHaveLength(2);
    expect(filterBank(r, { cefr: "all", category: "Arts & Literature" }).flagged).toHaveLength(1);
    expect(filterBank(r, { cefr: "C2", category: "all" })).toEqual({ ready: [], flagged: [] });
  });
  it("uses ready questions by default and never an unticked flagged one", () => {
    const pool = filterBank(bank(), { cefr: "all", category: "all" });
    const pick = pickForGame(pool, 50, new Set());
    expect(pick.count).toBe(5);
    expect(pick.usedFlagged).toBe(0);
    expect(pick.short).toBe(true);
    const ids = new Set(pool.flagged.map((i) => i.word!.id));
    expect(pick.words.some((w) => ids.has(w.id))).toBe(false);
  });
  it("a ticked flagged question is included, first", () => {
    const pool = filterBank(bank(), { cefr: "all", category: "all" });
    const tick = new Set([pool.flagged[0].sourceId]);
    const pick = pickForGame(pool, 3, tick);
    expect(pick.count).toBe(3);
    expect(pick.usedFlagged).toBe(1);
    expect(pick.words[0].id).toBe(pool.flagged[0].word!.id);
    expect(pickForGame(pool, 50, tick).available).toBe(6);
  });
  it("explains a shortfall instead of padding, picks the requested number otherwise, and caps a game", () => {
    const pool = filterBank(bank(), { cefr: "A2", category: "all" });
    expect(pickForGame(pool, 10, new Set())).toMatchObject({ count: 2, available: 2, short: true });
    const big = { ready: Array.from({ length: 70 }, () => convertBank({ v: 1, fileName: "", exportedAt: "", savedAt: "", questions: [question()] }).items[0]), flagged: [] };
    expect(pickForGame(big, 70, new Set()).count).toBe(MAX_GAME_WORDS);
    expect(pickForGame(big, 10, new Set())).toMatchObject({ count: 10, short: false });
    expect(pickForGame({ ready: [], flagged: [] }, 10, new Set())).toMatchObject({ count: 0, available: 0, words: [] });
  });
  it("shuffles without losing or repeating items and is deterministic with a fixed random source", () => {
    const src = [1, 2, 3, 4, 5, 6];
    const seq = () => { let i = 0; const v = [0.1, 0.9, 0.4, 0.7, 0.2]; return () => v[i++ % v.length]; };
    expect(shuffle(src, seq()).sort()).toEqual(src);
    expect(shuffle(src, seq())).toEqual(shuffle(src, seq()));
    expect(src).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("hosting a game straight from the bank (no activity or set)", () => {
  it("the picked words are accepted by the existing class service, with no Studio data involved", async () => {
    const s = memory();
    bankFromText(s, "b.json", exportText(Array.from({ length: 12 }, () => question())));
    const report = convertBank(loadBank(s)!);
    const pick = pickForGame(filterBank(report, { cefr: "A1", category: "Food & Drink" }), 10, new Set());
    expect(pick.words).toHaveLength(10);
    for (const w of pick.words) for (const h of w.hints) expect(leaksTarget(w, h)).toBe(false);
    const cls = new ClassService(new MemoryKV());
    const r = await cls.createActivity({ title: "Pair game — A1 · Food & Drink", words: JSON.parse(JSON.stringify(pick.words)) });
    expect(r.ok).toBe(true);
    expect(r.ok && r.activity.words).toHaveLength(10);
    expect(loadActivities(s).activities).toEqual([]); // nothing was saved as an activity
  });
  it("createClassLink posts the words to the existing hosting endpoint", async () => {
    const calls: { url: string; body: { set: { title: string; words: unknown[] } } }[] = [];
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000", hostname: "localhost" } });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ ok: true, path: "/class/abc123", lanUrls: [] }) }; });
    const words = convertBank({ v: 1, fileName: "", exportedAt: "", savedAt: "", questions: [question()] }).items.map((i) => i.word!);
    const r = await createClassLink("Pair game", words);
    vi.unstubAllGlobals();
    expect(calls[0].url).toBe("/api/class");
    expect(calls[0].body.set.words).toHaveLength(1);
    expect(r.ok && r.links.primary).toContain("/class/abc123");
  });
  it("the main teacher page does not depend on Studio, activities, sets or approval", () => {
    const src = readFileSync(new URL("../../components/class/BankHost.tsx", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/studio\/(ops|Studio|Workshop)|approveSet|createActivity|saveActivity|loadActivities|Writers/);
    expect(src).toMatch(/<QrCode url=\{links\.primary\} \/>/);
    expect(src).toMatch(/createClassLink\(/);
  });
});

const REAL = `${homedir()}/Downloads/quiz-bank-2026-11-12-424-questions.json`;
describe.runIf(existsSync(REAL))("the real export through the bank (read only)", () => {
  it("level/category filtering and selection work on all 424 questions", () => {
    const text = readFileSync(REAL, "utf8");
    const r = bankFromText(memory(), "real.json", text);
    expect(r.ok).toBe(true);
    const report = convertBank((r as { bank: Parameters<typeof convertBank>[0] }).bank);
    expect(report.counts.total).toBe(424);
    const pool = filterBank(report, { cefr: "A1", category: "Food & Drink" });
    const pick = pickForGame(pool, 10, new Set());
    expect(pick.count).toBe(10);
    expect(pick.words.every((w) => w.cefr === "A1" && w.category === "Food & Drink" && w.hints.length === 4)).toBe(true); // ready questions keep all four clues
    expect(readFileSync(REAL, "utf8")).toBe(text);
  });
});

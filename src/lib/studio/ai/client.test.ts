import { afterEach, describe, expect, it, vi } from "vitest";
import { callStudio } from "./client";
import { EMPTY_BRIEF } from "../types";

const TEN = ["bakery", "library", "post office", "department store", "vehicle bureau", "pharmacy", "museum", "bus station", "town hall", "stadium"];
const good = (w: string) => [`You go there on a busy Saturday morning, number ${w.length}.`, "It has a particular smell and a particular sound inside it.", `Unlike a home, a ____ is a place you visit for one purpose (${w.length}).`];
const item = (word: string, over: Record<string, unknown> = {}) => ({
  id: `id-${word}`, word, partOfSpeech: "noun", cefr: "B1", category: "Places in town", meaning: `a place (${word.length})`, example: `We went to the ${word}.`, hints: good(word), ...over,
});
const leakyHint2 = (w: string) => item(w, { hints: [good(w)[0], `Officials at the ${w.split(" ")[0]} office check your papers.`, good(w)[2]] });

const serve = (data: Record<string, unknown>) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, mode: "openai", data: { task: "generate", requested: 10, issues: [], ...data } }), { status: 200 })));
const call = (approved = TEN) => callStudio("generate", { brief: EMPTY_BRIEF, count: approved.length, exclude: [], approved });

afterEach(() => vi.unstubAllGlobals());

describe("the browser client keeps every approved word the server returned (the real-browser bug)", () => {
  it("a word whose hint fails the browser's check is KEPT and flagged — not dropped", async () => {
    serve({ words: TEN.map((w) => (w === "vehicle bureau" ? leakyHint2(w) : item(w))) });
    const r = await call();
    expect(r.data.words.map((w) => w.word)).toEqual(TEN); // all ten
    expect(r.data.flagged?.map((f) => f.word)).toEqual(["vehicle bureau"]);
    expect(r.data.flagged![0].hints).toEqual([1]);
    expect(r.data.flagged![0].reason).toMatch(/Hint 2 gives away the word/);
    expect(r.data.failed).toBeUndefined();
  });
  it("the server's failed and flagged lists are passed on, not discarded", async () => {
    serve({
      words: TEN.filter((w) => w !== "stadium").map((w) => (w === "bakery" ? leakyHint2(w) : item(w))),
      failed: [{ word: "stadium", reason: "The AI did not return an item for this word." }],
      flagged: [{ word: "bakery", reason: "Hint 2 gives away the word.", hints: [1] }],
    });
    const r = await call();
    expect(r.data.words).toHaveLength(9);
    expect(r.data.failed).toEqual([{ word: "stadium", reason: "The AI did not return an item for this word." }]);
    expect(r.data.flagged?.map((f) => f.word)).toEqual(["bakery"]);
  });
  it("a word the browser has to reject for another reason is reported as failed with the reason", async () => {
    serve({ words: TEN.map((w) => (w === "museum" ? item(w, { meaning: "" }) : item(w))) });
    const r = await call();
    expect(r.data.words.map((w) => w.word)).not.toContain("museum");
    expect(r.data.failed?.map((f) => f.word)).toEqual(["museum"]);
    expect(r.data.failed![0].reason.length).toBeGreaterThan(5);
  });
  it("free generation (no approved list) still discards unusable AI items quietly, as before", async () => {
    serve({ words: [item("alpha"), item("beta", { meaning: "" })] });
    const r = await callStudio("generate", { brief: EMPTY_BRIEF, count: 2, exclude: [] });
    expect(r.data.words.map((w) => w.word)).toEqual(["alpha"]);
    expect(r.data.failed).toBeUndefined();
  });
});

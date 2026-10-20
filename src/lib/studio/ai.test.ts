import { describe, expect, it, vi } from "vitest";
import { validateWord } from "./validation";
import { EMPTY_BRIEF, type Brief } from "./types";
import { MOCK_TOPICS } from "./ai/mockBank";
import { coerceWord } from "./validation";
import { detectTopicKey, mockChat, mockGenerate, mockHints, mockReplace } from "./ai/mock";
import { handleStudioRequest } from "./ai/service";
import { parseStudioRequest } from "./ai/parse";
import { normalize } from "@/lib/answer";

const seeded = () => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };
const brief = (over: Partial<Brief> = {}): Brief => ({ ...EMPTY_BRIEF, ...over });

describe("mock bank quality", () => {
  it("every demo entry passes the same validation as real AI output (no leaks!)", () => {
    for (const [key, topic] of Object.entries(MOCK_TOPICS)) {
      expect(topic.entries.length, key).toBeGreaterThanOrEqual(10);
      const seen = new Set<string>();
      for (const e of topic.entries) {
        const c = coerceWord(e);
        expect("word" in c, `${e.word} coerces`).toBe(true);
        if ("word" in c) {
          const errors = validateWord(c.word).filter((i) => i.severity === "error");
          expect(errors, `${e.word}: ${errors.map((x) => x.message).join(" ")}`).toEqual([]);
        }
        expect(seen.has(normalize(e.word)), `duplicate ${e.word}`).toBe(false);
        seen.add(normalize(e.word));
      }
    }
  });
  it("covers objects, actions, expressions and abstract vocabulary across A1–C1", () => {
    const levels = new Set(Object.values(MOCK_TOPICS).flatMap((t) => t.entries.map((e) => e.cefr)));
    expect([...levels].sort()).toEqual(["A1", "A2", "B1", "B2", "C1"]);
    const pos = new Set(Object.values(MOCK_TOPICS).flatMap((t) => t.entries.map((e) => e.partOfSpeech)));
    expect(pos.has("phrase") && pos.has("verb") && pos.has("adjective") && pos.has("noun")).toBe(true);
  });
});

describe("mock generation", () => {
  it("returns ten distinct words spanning familiar to challenging — the activity level does not filter words", () => {
    const words = mockGenerate(brief({ topic: "Common fruits", level: "A1" }), 10, [], seeded());
    expect(words).toHaveLength(10);
    expect(new Set(words.map((w) => w.word)).size).toBe(10);
    expect(new Set(words.map((w) => w.cefr)).size).toBeGreaterThan(1); // a mixture, not only A1
    const adv = mockGenerate(brief({ topic: "Personality and emotions", level: "C1" }), 10, [], seeded());
    expect(adv.some((w) => w.cefr === "B2")).toBe(true);
    const low = mockGenerate(brief({ topic: "Personality and emotions", level: "A1" }), 10, [], seeded());
    expect(low).toHaveLength(10);
    expect(low.some((w) => w.cefr === "C1")).toBe(true);
  });
  it("a second set never repeats the first (topic bigger than ten words)", () => {
    const b = brief({ topic: "Everyday physical actions", level: "B2" });
    const first = mockGenerate(b, 10, [], seeded());
    const second = mockGenerate(b, 10, first.map((w) => w.word), seeded());
    expect(second.length).toBeGreaterThan(0);
    expect(second.length).toBeLessThan(10); // honest: demo bank is finite
    expect(second.some((w) => first.some((f) => f.word === w.word))).toBe(false);
  });
  it("errors honestly for unsupported topics", () => {
    expect(() => mockGenerate(brief({ topic: "Dinosaurs", level: "B1" }), 10, [])).toThrow(/Mock AI only has demo vocabulary/);
  });
  it("replaces one word with a different valid one", () => {
    const [cur, ...others] = mockGenerate(brief({ topic: "Less common fruits", level: "B2" }), 10, [], seeded());
    const next = mockReplace(brief({ topic: "Less common fruits", level: "B2" }), cur, others.map((w) => w.word), seeded());
    expect(next.word).not.toBe(cur.word);
    expect(others.some((o) => o.word === next.word)).toBe(false);
  });
  it("writes valid template hints that do not reveal the word", () => {
    const [w] = mockGenerate(brief({ topic: "Personality and emotions", level: "C1" }), 1, [], seeded());
    const hints = mockHints(w);
    expect(hints).toHaveLength(3);
    expect(hints.join(" ").toLowerCase()).not.toContain(w.word.toLowerCase());
  });
});

describe("mock conversation", () => {
  const say = (text: string, prev = brief(), ctx?: Parameters<typeof mockChat>[2]) => mockChat([{ role: "teacher", text }], prev, ctx);
  it("understands the teacher's example requests", () => {
    const r = say("Create A1 vocabulary about common fruits.");
    expect(r.brief).toMatchObject({ topic: "Common fruits", level: "A1" });
    expect(r.ready).toBe(true);
    expect(r.command).toBeNull();
    expect(say("Make a B2 activity about everyday physical actions").brief).toMatchObject({ topic: "Everyday physical actions", level: "B2" });
    expect(say("I want C1 vocabulary for describing personality and emotions").brief).toMatchObject({ level: "C1", topic: "Personality and emotions" });
  });
  it("asks a clarifying question when level or topic is missing", () => {
    const noLevel = say("I'd like some words about fruit");
    expect(noLevel.ready).toBe(false);
    expect(noLevel.reply).toMatch(/level/i);
    const nothing = say("hello");
    expect(nothing.ready).toBe(false);
    expect(nothing.reply).toMatch(/about/i);
  });
  it("handles 'less common fruits' as a topic change without re-levelling the activity", () => {
    const first = say("Create A1 vocabulary about common fruits");
    const r = say("I want less common fruits", first.brief);
    expect(r.brief.topic).toBe("Less common fruits");
    expect(r.brief.level).toBe("A1"); // the overall communication level is the teacher's call, not tied to the words
  });
  it("captures the number of sets and learner focus", () => {
    const r = say("Make three sets of B1 expressions. Japanese students understand them but struggle to produce them.");
    expect(r.brief.numSets).toBe(3);
    expect(r.brief.topic).toBe("Everyday expressions");
    expect(r.brief.learnerFocus).toMatch(/Japanese/);
  });
  it("turns explicit requests into commands only when asked", () => {
    const ctx = { words: Array.from({ length: 10 }, (_, i) => ({ position: i + 1, word: `w${i}`, cefr: "A1" })) };
    const b = brief({ topic: "Common fruits", level: "A1" });
    expect(say("generate", b).command).toEqual({ type: "generate" });
    expect(say("Replace word #3 with something less common", b, ctx).command).toMatchObject({ type: "replace-word", position: 3 });
    expect(say("Give me easier hints for number 7", b, ctx).command).toMatchObject({ type: "regenerate-hints", position: 7 });
    expect(say("regenerate the whole set", b, ctx).command).toMatchObject({ type: "regenerate-set" });
    expect(say("Replace word #3", b).command).toBeNull(); // no set on screen
    expect(say("generate", brief()).command).toBeNull(); // not ready
    expect(detectTopicKey("zebras")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

const aiWord = (word: string, over: Record<string, unknown> = {}) => ({
  word, accept: [], partOfSpeech: "noun", cefr: "B1", category: "Test", meaning: `meaning of ${word}`,
  example: `A sentence with ${word}.`, hints: ["one", "two", "three"], ...over,
});
const okFetch = (payload: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 }));
const deps = (fetchImpl: ReturnType<typeof vi.fn>) => ({ apiKey: "test-key-not-real", model: "test-model", fetchImpl: fetchImpl as never });

describe("service — mode selection (no network, no cost)", () => {
  it("uses the mock when no API key is configured", async () => {
    const f = vi.fn();
    const r = await handleStudioRequest({ task: "generate", brief: brief({ topic: "Common fruits", level: "A1" }), count: 10, exclude: [] }, { fetchImpl: f as never });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("mock");
    expect(f).not.toHaveBeenCalled();
  });
  it("honours forceMock even when a key exists (free testing)", async () => {
    const f = okFetch({});
    const r = await handleStudioRequest({ task: "generate", forceMock: true, brief: brief({ topic: "Common fruits", level: "A1" }), count: 10, exclude: [] }, deps(f));
    expect(r.body.mode).toBe("mock");
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects malformed requests", async () => {
    for (const body of [null, "x", { task: "nope" }, { task: "chat", messages: [], brief: {} }, { task: "chat", messages: [{ role: "ai", text: "hi" }], brief: {} }]) {
      const r = await handleStudioRequest(body, {});
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
    }
    expect(() => parseStudioRequest({ task: "generate", brief: {}, count: 999 })).not.toThrow();
  });
});

describe("service — real AI path with a FAKE fetch", () => {
  const req = { task: "generate", brief: brief({ topic: "Test", level: "B1" }), count: 3, exclude: ["old"] };

  it("sends the key only in the Authorization header to OpenAI and returns validated words", async () => {
    const f = okFetch({ words: [aiWord("alpha"), aiWord("beta"), aiWord("gamma")] });
    const r = await handleStudioRequest(req, deps(f));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: "openai", model: "test-model" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key-not-real");
    expect(JSON.stringify(r.body)).not.toContain("test-key-not-real"); // never echoed to the browser
    expect(String(init.body)).not.toContain("test-key-not-real");
  });
  it("filters hint leaks/duplicates/malformed items and tops up once", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ words: [aiWord("alpha"), aiWord("beta", { hints: ["a beta!", "x", "y"] }), { junk: true }] }) } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ words: [aiWord("gamma"), aiWord("alpha"), aiWord("delta")] }) } }] })));
    const r = await handleStudioRequest(req, deps(f));
    expect(r.status).toBe(200);
    if (r.body.ok && r.body.data.task === "generate") {
      expect(r.body.data.words.map((w) => w.word)).toEqual(["alpha", "gamma", "delta"]);
      expect(r.body.data.issues.length).toBeGreaterThanOrEqual(2);
    } else throw new Error("unexpected");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("never returns words from the exclude list", async () => {
    const f = okFetch({ words: [aiWord("old"), aiWord("fresh")] });
    const r = await handleStudioRequest({ ...req, count: 1 }, deps(f));
    if (r.body.ok && r.body.data.task === "generate") expect(r.body.data.words.map((w) => w.word)).toEqual(["fresh"]);
    else throw new Error("unexpected");
  });
  it("handles non-JSON, wrong-shape and error responses safely", async () => {
    const cases: [string, () => Promise<Response>, number][] = [
      ["not json content", async () => new Response(JSON.stringify({ choices: [{ message: { content: "Sure! here are words" } }] })), 502],
      ["no choices", async () => new Response(JSON.stringify({})), 502],
      ["all invalid", async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ words: [{ x: 1 }] }) } }] })), 502],
      ["http 401", async () => new Response("secret upstream body", { status: 401 }), 502],
      ["unreadable body", async () => new Response("<html>", { status: 200 }), 502],
    ];
    for (const [name, impl, status] of cases) {
      const r = await handleStudioRequest(req, deps(vi.fn(impl)));
      expect(r.status, name).toBe(status);
      expect(r.body.ok, name).toBe(false);
      expect(JSON.stringify(r.body), name).not.toContain("secret upstream body");
    }
  });
  it("reports timeouts and network failures without crashing", async () => {
    const timeout = vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
    expect((await handleStudioRequest(req, deps(timeout))).status).toBe(504);
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect((await handleStudioRequest(req, deps(down))).status).toBe(502);
  });
  it("validates chat replies and clamps the brief", async () => {
    const f = okFetch({ reply: "Sounds good!", ready: true, brief: { topic: "Fruit", level: "b1", numSets: 99, objectives: ["speak"], avoid: [] }, command: { type: "replace-word", position: 99 } });
    const r = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: "fruit B1" }], brief: brief() }, deps(f));
    if (r.body.ok && r.body.data.task === "chat") {
      expect(r.body.data.result.brief).toMatchObject({ topic: "Fruit", level: "B1", numSets: 5 });
      expect(r.body.data.result.command).toBeNull(); // out-of-range position dropped
      expect(r.body.data.result.ready).toBe(true);
    } else throw new Error("unexpected");
    const bad = await handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: "x" }], brief: brief() }, deps(okFetch({ reply: "" })));
    expect(bad.status).toBe(502);
  });
  it("accepts regenerated hints only if they do not reveal the word", async () => {
    const word = { id: "w1", ...aiWord("umbrella") };
    const good = okFetch({ hints: ["rain", "handle", "starts with U"] });
    const r1 = await handleStudioRequest({ task: "regenerate-hints", brief: brief(), word }, deps(good));
    expect(r1.status).toBe(200);
    const leaky = okFetch({ hints: ["an umbrella", "handle", "U"] });
    const r2 = await handleStudioRequest({ task: "regenerate-hints", brief: brief(), word }, deps(leaky));
    expect(r2.status).toBe(502);
    expect(leaky).toHaveBeenCalledTimes(2); // one retry, then a safe failure
  });
});

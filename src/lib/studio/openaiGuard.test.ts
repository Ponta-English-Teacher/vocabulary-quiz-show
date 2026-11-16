import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { selectWords } from "@/lib/playCount";
import { OPENAI_SWITCH, openAIEnabled, openAIKey } from "./ai/guard";
import { callOpenAIJson } from "./ai/openai";
import { translateJapanese } from "./ai/japanese";
import { generateIllustration } from "./illustration";
import { POST as studioPost, GET as studioGet } from "@/app/api/studio/route";
import { POST as illustratePost } from "@/app/api/studio/illustrate/route";
import { ClassService, envDrawer, envTranslator } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";

/**
 * OpenAI is OFF by default. Every outbound request is caught by a fake global fetch: if any code path tried to reach OpenAI
 * (or anything else), `net` would have been called. A real API key is present in the environment to prove that a key alone
 * does not switch OpenAI on.
 */
const PASS = "guard-test-passcode";
let net: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-fake-key-must-never-be-used");
  vi.stubEnv(OPENAI_SWITCH, "");
  vi.stubEnv("TEACHER_PASSCODE", PASS);
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "VERCEL", "OPENAI_IMAGES_URL"]) vi.stubEnv(k, "");
  net = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", net);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const word = selectWords(SAMPLE_SET.words, 1)[0];
const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-teacher-passcode": PASS, "x-forwarded-for": "10.9.9.9" }, body: JSON.stringify(body) });

describe("the OpenAI switch", () => {
  it("is off unless VQS_OPENAI_ENABLED is exactly \"true\"; a key alone never enables it", () => {
    expect(openAIEnabled({})).toBe(false);
    expect(openAIEnabled({ OPENAI_API_KEY: "sk-x" })).toBe(false);
    for (const v of ["1", "yes", "TRUE", "True", " true", "on"]) expect(openAIEnabled({ [OPENAI_SWITCH]: v })).toBe(false);
    expect(openAIEnabled({ [OPENAI_SWITCH]: "true" })).toBe(true);
    expect(openAIKey({ OPENAI_API_KEY: "sk-x" })).toBeUndefined();
    expect(openAIKey({ OPENAI_API_KEY: "sk-x", [OPENAI_SWITCH]: "true" })).toBe("sk-x");
    expect(openAIKey()).toBeUndefined(); // this test environment: key set, switch off
  });
});

describe("backstop: the functions that contact OpenAI refuse the real network while off", () => {
  it("chat completions (question generation, hints, translation)", async () => {
    await expect(callOpenAIJson({ apiKey: "sk-x", model: "gpt-4o-mini" }, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "disabled" });
    await expect(translateJapanese({ apiKey: "sk-x", model: "gpt-4o-mini" }, [{ word: "apple", partOfSpeech: "noun", meaning: "a fruit" }])).rejects.toMatchObject({ code: "disabled" });
    expect(net).not.toHaveBeenCalled();
  });
  it("image generation, including a custom image address", async () => {
    await expect(generateIllustration({ apiKey: "sk-x" }, word)).rejects.toMatchObject({ code: "no_ai" });
    await expect(generateIllustration({ apiKey: "sk-x", url: "https://example.com/images" }, word)).rejects.toMatchObject({ code: "no_ai" });
    expect(net).not.toHaveBeenCalled();
  });
});

describe("teacher routes (Studio) while off", () => {
  it("status reports mock mode and that OpenAI is disabled", async () => {
    expect(await (await studioGet()).json()).toEqual({ mode: "mock", model: null, openai: "disabled" });
  });
  it("chat, generate and the automatic Japanese fill are answered by the free mock, even when the mock switch is NOT pressed", async () => {
    const brief = {};
    for (const body of [
      { task: "chat", messages: [{ role: "teacher", text: "A1 fruit words" }], brief, forceMock: false },
      { task: "generate", brief: { topic: "fruit", level: "A1" }, count: 3, exclude: [], forceMock: false },
      { task: "fill-japanese", brief, words: [{ word: "apple", partOfSpeech: "noun", meaning: "a fruit" }] },
    ]) {
      const res = await studioPost(post("/api/studio", body));
      const j = await res.json();
      expect(j.mode, body.task).toBe("mock");
    }
    expect(net).not.toHaveBeenCalled();
  });
  it("Studio picture drawing returns a clear 503 without contacting OpenAI", async () => {
    const res = await illustratePost(post("/api/studio/illustrate", { word }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, error: { code: "ai_disabled" } });
    expect(j.error.message).toMatch(/OpenAI is turned off/);
    expect(net).not.toHaveBeenCalled();
  });
});

describe("student-triggered requests (production drawer and translator) while off", () => {
  async function game(words: VocabWord[]) {
    const now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, { drawer: envDrawer, translator: envTranslator });
    const c = await svc.createActivity({ title: "Guard", words });
    if (!c.ok) throw new Error("create");
    const id = c.activity.id;
    const join = async (name: string) => { const r = await svc.join({ activityId: id, group: "1", name }); if (!r.ok) throw new Error("join"); return r.token; };
    const a = await join("Aki"), b = await join("Ben");
    let n = 0;
    const act = (token: string, action: object) => svc.act({ activityId: id, group: "1", token, opId: `op${++n}`, action: action as never });
    return { svc, id, a, b, act };
  }

  it("a Giver asking for a picture gets a clear refusal, the score is unchanged, and nothing is sent", async () => {
    const words = selectWords(SAMPLE_SET.words, 3);
    const g = await game(words);
    await g.act(g.a, { type: "PROPOSE_ROLES", giver: "me" });
    await g.act(g.b, { type: "CONFIRM_ROLES" });
    await g.act(g.a, { type: "CONTINUE" });
    await g.act(g.a, { type: "PICK", wordId: words[0].id });
    const giver = g.a; // Aki proposed to be the Giver
    const r = await g.svc.requestIllustration({ activityId: g.id, group: "1", token: giver });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/score is unchanged/);
    const after = await g.svc.getView({ activityId: g.id, group: "1", token: giver });
    if (!after.ok || after.unchanged) throw new Error("view");
    expect(after.view.game?.phase).toBe("round");
    expect(after.view.game?.illustrationUsed).toBeFalsy();
    expect(after.view.game?.players.map((p) => p.score)).toEqual([0, 0]);
    expect(net).not.toHaveBeenCalled();
  });

  it("the study page of words with no Japanese is served without a translation request", async () => {
    const plain = selectWords(SAMPLE_SET.words, 3).map((w) => ({ ...w, ja: [], studyJa: undefined }));
    const g = await game(plain);
    const r = await g.svc.getStudy({ activityId: g.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.words).toHaveLength(3);
    expect(net).not.toHaveBeenCalled();
  });
});

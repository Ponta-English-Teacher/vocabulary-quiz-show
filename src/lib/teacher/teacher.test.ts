import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV } from "@/lib/class/kv";
import { SAMPLE_SET } from "@/data/vocab";
import { POST as createClass } from "@/app/api/class/route";
import { POST as studio, GET as studioStatus } from "@/app/api/studio/route";
import { GET as teacherMode, POST as verify } from "@/app/api/teacher/route";
import { POST as join } from "@/app/api/class/[activityId]/join/route";
import { MAX_FAILURES, checkTeacher, safeEqual, teacherMode as modeOf } from "./auth";

const ctx = (id: string) => ({ params: Promise.resolve({ activityId: id }) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("teacher mode", () => {
  it("passcode set → passcode; unset on Vercel → LOCKED; unset locally → open", () => {
    expect(modeOf({ TEACHER_PASSCODE: "x" })).toBe("passcode");
    expect(modeOf({ TEACHER_PASSCODE: "x", VERCEL: "1" })).toBe("passcode");
    expect(modeOf({ VERCEL: "1" })).toBe("locked");
    expect(modeOf({})).toBe("open");
  });
  it("compares in constant time and treats different lengths as unequal", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc123", "abc124")).toBe(false);
    expect(safeEqual("abc", "abc123")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("passcode checking and lockout", () => {
  const env = { TEACHER_PASSCODE: "correct horse" };
  it("accepts the right passcode, rejects wrong or missing ones", async () => {
    const kv = new MemoryKV();
    expect(await checkTeacher("correct horse", env, () => kv, "1.1.1.1")).toEqual({ ok: true });
    expect(await checkTeacher("nope", env, () => kv, "1.1.1.1")).toMatchObject({ ok: false, status: 401, code: "teacher_auth" });
    expect(await checkTeacher(null, env, () => kv, "1.1.1.1")).toMatchObject({ ok: false, status: 401, message: expect.stringMatching(/required/) });
  });
  it("after too many wrong guesses even the CORRECT passcode is refused (no brute force)", async () => {
    const kv = new MemoryKV();
    for (let i = 0; i < MAX_FAILURES; i++) await checkTeacher(`guess${i}`, env, () => kv, "9.9.9.9");
    expect(await checkTeacher("correct horse", env, () => kv, "9.9.9.9")).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    // …but a different client is unaffected, and the lock expires
    expect(await checkTeacher("correct horse", env, () => kv, "8.8.8.8")).toEqual({ ok: true });
  });
  it("the lockout clears after the window", async () => {
    let now = 0;
    const kv = new MemoryKV(() => now);
    for (let i = 0; i < MAX_FAILURES; i++) await checkTeacher("bad", env, () => kv, "7.7.7.7");
    now += 11 * 60 * 1000;
    expect(await checkTeacher("correct horse", env, () => kv, "7.7.7.7")).toEqual({ ok: true });
  });
  it("still enforces the passcode when the counter storage is down", async () => {
    const down = () => { throw new Error("no storage"); };
    expect(await checkTeacher("correct horse", env, down as never, "c")).toEqual({ ok: true });
    expect(await checkTeacher("wrong", env, down as never, "c")).toMatchObject({ ok: false, status: 401 });
  });
  it("on Vercel with no passcode configured every teacher request is refused", async () => {
    expect(await checkTeacher("anything", { VERCEL: "1" }, () => new MemoryKV(), "c")).toMatchObject({ ok: false, status: 503, code: "not_configured" });
  });
});

describe("teacher-only endpoints are protected; student endpoints are not", () => {
  beforeEach(() => { vi.stubEnv("TEACHER_PASSCODE", "classroom-pass"); vi.stubEnv("OPENAI_API_KEY", ""); });
  afterEach(() => vi.unstubAllEnvs());
  const chat = { task: "chat", messages: [{ role: "teacher", text: "Create A1 vocabulary about common fruits." }], brief: {} };
  const classBody = { set: { title: "T", words: SAMPLE_SET.words } };

  it("/api/studio (spends OpenAI credit) needs the passcode", async () => {
    const ip = { "x-forwarded-for": "10.0.0.1" };
    const none = await studio(post("/api/studio", chat, ip));
    expect(none.status).toBe(401);
    expect(JSON.stringify(await none.json())).not.toContain("classroom-pass");
    expect((await studio(post("/api/studio", chat, { ...ip, "x-teacher-passcode": "wrong" }))).status).toBe(401);
    const ok = await studio(post("/api/studio", chat, { ...ip, "x-teacher-passcode": "classroom-pass" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.task).toBe("chat");
  });
  it("creating a class link needs the passcode", async () => {
    const ip = { "x-forwarded-for": "10.0.0.2" };
    expect((await createClass(post("/api/class", classBody, ip))).status).toBe(401);
    const ok = await createClass(post("/api/class", classBody, { ...ip, "x-teacher-passcode": "classroom-pass" }));
    expect(ok.status).toBe(200);
    const { id, lanUrls } = await ok.json();
    expect(id).toMatch(/^[0-9a-f]{10}$/);
    expect(Array.isArray(lanUrls)).toBe(true);
  });
  it("students never need the passcode to join (they hold only a class link)", async () => {
    const made = await createClass(post("/api/class", classBody, { "x-forwarded-for": "10.0.0.3", "x-teacher-passcode": "classroom-pass" }));
    const { id } = await made.json();
    const res = await join(post("/x", { group: "4", name: "Aki" }), ctx(id));
    expect(res.status).toBe(200);
  });
  it("the passcode endpoint reports the mode and verifies guesses (counting toward the lockout)", async () => {
    expect((await (await teacherMode()).json()).mode).toBe("passcode");
    const ip = { "x-forwarded-for": "10.0.0.4" };
    expect((await verify(post("/api/teacher", { passcode: "classroom-pass" }, ip))).status).toBe(200);
    expect((await verify(post("/api/teacher", { passcode: "no" }, ip))).status).toBe(401);
    expect((await verify(post("/api/teacher", "not an object", ip))).status).toBe(401);
    for (let i = 0; i < MAX_FAILURES; i++) await verify(post("/api/teacher", { passcode: `g${i}` }, { "x-forwarded-for": "10.0.0.5" }));
    expect((await verify(post("/api/teacher", { passcode: "classroom-pass" }, { "x-forwarded-for": "10.0.0.5" }))).status).toBe(429);
  });
  it("the public status endpoint reveals the AI mode but no secret", async () => {
    const body = JSON.stringify(await (await studioStatus()).json());
    expect(body).not.toMatch(/classroom-pass|sk-/);
  });
});

describe("on Vercel without a passcode the teacher endpoints are locked", () => {
  beforeEach(() => { vi.stubEnv("VERCEL", "1"); vi.stubEnv("TEACHER_PASSCODE", ""); vi.stubEnv("OPENAI_API_KEY", "fake-openai-key-never-used"); });
  afterEach(() => vi.unstubAllEnvs());
  it("refuses Studio and class-link creation (so a public deployment can't be used to spend OpenAI credit)", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await studio(post("/api/studio", { task: "chat", messages: [], brief: {} }))).status).toBe(503);
    expect((await createClass(post("/api/class", { set: { title: "T", words: SAMPLE_SET.words } }))).status).toBe(503);
    expect((await (await teacherMode()).json()).mode).toBe("locked");
    expect(f).not.toHaveBeenCalled(); // no outbound call (OpenAI) was attempted
    vi.unstubAllGlobals();
  });
});

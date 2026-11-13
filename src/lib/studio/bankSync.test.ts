import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/bank/sync/route";
import { fetchLatestBank, SYNC_MAX_BYTES, syncConfig } from "./bankSyncServer";
import { requestLatestBank } from "./cqsSync";
import { BANK_KEY, convertBank, evaluateSync, loadBank, markSynced, saveBank, SHRINK_CONFIRM_BELOW, type SavedBank } from "./cqsBank";
import type { StorageLike } from "./storage";

const TOKEN = "s".repeat(48);
const PASS = "teacher-pass-123";
const ETAG = `"cqs-${"a".repeat(24)}"`;
let n = 0;
const question = () => {
  const name = `fruit${[...String(n++)].map((d) => String.fromCharCode(97 + Number(d))).join("")}`;
  return {
    id: `q${n}`, cefrLevel: "A1", categoryId: "food", categoryName: "Food & Drink", prompt: "What food is this?",
    chunks: [`Clue four for ${n} is hard.`, `People eat it at lunch number ${n}.`, `It is a tasty snack that kids like ${n}.`, `It is a sweet food from a shop ${n}.`],
    choices: [name, "b", "c", "d"], correctIndex: 0, answer: name, status: "approved",
  };
};
const exportText = (count: number) => JSON.stringify({ format: "classroom-quiz-show/questions", version: 1, exportedAt: "2026-11-14T00:00:00Z", count, questions: Array.from({ length: count }, question) });
const memory = (): StorageLike & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
};
const cfg = { url: "https://cqs.example.com/api/sync/bank", token: TOKEN };
const reply = (body: string | null, init: ResponseInit = {}) => new Response(body, init);

describe("server configuration", () => {
  it("needs a long token, and the address must be https (http only for localhost), without credentials", () => {
    expect(syncConfig({})).toMatchObject({ ok: false });
    expect(syncConfig({ CQS_SYNC_TOKEN: "short" })).toMatchObject({ ok: false });
    expect(syncConfig({ CQS_SYNC_TOKEN: TOKEN })).toEqual({ ok: true, url: "https://classroom-quiz-show.vercel.app/api/sync/bank", token: TOKEN });
    expect(syncConfig({ CQS_SYNC_TOKEN: TOKEN, CQS_BASE_URL: "https://cqs.example.com/some/path" })).toMatchObject({ ok: true, url: "https://cqs.example.com/api/sync/bank" });
    expect(syncConfig({ CQS_SYNC_TOKEN: TOKEN, CQS_BASE_URL: "http://localhost:3001" })).toMatchObject({ ok: true, url: "http://localhost:3001/api/sync/bank" });
    for (const bad of ["http://cqs.example.com", "https://user:pw@cqs.example.com", "not a url", "ftp://cqs.example.com"]) {
      expect(syncConfig({ CQS_SYNC_TOKEN: TOKEN, CQS_BASE_URL: bad })).toMatchObject({ ok: false });
    }
    expect(JSON.stringify(syncConfig({ CQS_SYNC_TOKEN: "short" }))).not.toContain("short");
  });
});

describe("fetching from Classroom Quiz Show", () => {
  it("sends the bearer token and the saved version, never follows redirects, and returns the text and new version", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(exportText(3), { status: 200, headers: { etag: ETAG } }); }) as unknown as typeof fetch;
    const r = await fetchLatestBank(cfg, ETAG, f);
    expect(r).toMatchObject({ kind: "ok", etag: ETAG });
    expect(calls[0].url).toBe(cfg.url);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h["If-None-Match"]).toBe(ETAG);
    expect(calls[0].init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    // a malformed version is never forwarded
    await fetchLatestBank(cfg, 'x"; evil', f);
    expect((calls[1].init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
  });
  it("accepts the weak version tag a compressing host sends, and stores it in its strong form", async () => {
    const f = (async () => reply(exportText(2), { status: 200, headers: { etag: `W/${ETAG}` } })) as unknown as typeof fetch;
    expect(await fetchLatestBank(cfg, undefined, f)).toMatchObject({ kind: "ok", etag: ETAG });
    const junk = (async () => reply(exportText(2), { status: 200, headers: { etag: 'W/"other"' } })) as unknown as typeof fetch;
    expect(await fetchLatestBank(cfg, undefined, junk)).not.toHaveProperty("etag");
  });
  it("304 means unchanged", async () => {
    expect(await fetchLatestBank(cfg, ETAG, (async () => reply(null, { status: 304 })) as unknown as typeof fetch)).toEqual({ kind: "unchanged" });
  });
  it("maps failures to plain messages that never contain the token", async () => {
    const codes: [number, string][] = [[401, "sync_rejected"], [403, "sync_rejected"], [503, "sync_off"], [429, "sync_busy"], [500, "sync_failed"]];
    for (const [status, code] of codes) {
      const r = await fetchLatestBank(cfg, undefined, (async () => reply(`secret ${TOKEN}`, { status })) as unknown as typeof fetch);
      expect(r).toMatchObject({ kind: "error", code });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
  it("gives up on a slow server, an unreachable one, and a redirect", async () => {
    const slow = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener("abort", () => rej(new Error("aborted"))); })) as unknown as typeof fetch;
    expect(await fetchLatestBank(cfg, undefined, slow, 30)).toMatchObject({ kind: "error", code: "sync_timeout", status: 504 });
    expect(await fetchLatestBank(cfg, undefined, (async () => { throw new TypeError(`connect failed ${TOKEN}`); }) as unknown as typeof fetch)).toMatchObject({ code: "sync_unreachable" });
    const r = await fetchLatestBank(cfg, undefined, (async () => { throw new TypeError("fetch failed: unexpected redirect"); }) as unknown as typeof fetch);
    expect(r).toMatchObject({ code: "sync_redirect" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it("refuses an oversized answer, declared or streamed, and an answer that is not a question bank", async () => {
    expect(await fetchLatestBank(cfg, undefined, (async () => reply("x", { status: 200, headers: { "content-length": String(SYNC_MAX_BYTES + 1) } })) as unknown as typeof fetch)).toMatchObject({ code: "sync_too_large" });
    const big = "x".repeat(SYNC_MAX_BYTES + 10);
    expect(await fetchLatestBank(cfg, undefined, (async () => reply(big, { status: 200 })) as unknown as typeof fetch)).toMatchObject({ code: "sync_too_large" });
    expect(await fetchLatestBank(cfg, undefined, (async () => reply("<html>", { status: 200 })) as unknown as typeof fetch)).toMatchObject({ code: "sync_bad_data" });
    expect(await fetchLatestBank(cfg, undefined, (async () => reply(JSON.stringify({ format: "other", version: 1, questions: [] }), { status: 200 })) as unknown as typeof fetch)).toMatchObject({ code: "sync_bad_data" });
  });
});

describe("POST /api/bank/sync", () => {
  beforeEach(() => {
    vi.stubEnv("TEACHER_PASSCODE", PASS);
    vi.stubEnv("CQS_SYNC_TOKEN", TOKEN);
    vi.stubEnv("CQS_BASE_URL", "https://cqs.example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  let ip = 0;
  const call = (opts: { pass?: string | null; body?: string } = {}) =>
    POST(new Request("https://vqs.example.com/api/bank/sync", { method: "POST", headers: { "x-forwarded-for": `192.0.2.${++ip}`, ...(opts.pass === null ? {} : { "x-teacher-passcode": opts.pass ?? PASS }) }, body: opts.body ?? "{}" }));
  const cqs = (r: () => Response) => vi.stubGlobal("fetch", vi.fn(async () => r()));

  it("needs the teacher passcode, and calls Classroom Quiz Show only for a teacher", async () => {
    const f = vi.fn(async () => reply(exportText(2), { status: 200, headers: { etag: ETAG } }));
    vi.stubGlobal("fetch", f);
    expect((await call({ pass: null })).status).toBe(401);
    expect((await call({ pass: "wrong" })).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await ok.json()).toMatchObject({ ok: true, status: "ok", etag: ETAG });
  });
  it("never puts the token in a response, even when Classroom Quiz Show rejects it", async () => {
    cqs(() => reply(`bad token ${TOKEN}`, { status: 401 }));
    const res = await call();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("sync_rejected");
  });
  it("says so plainly when sync is not set up, without calling anything", async () => {
    vi.stubEnv("CQS_SYNC_TOKEN", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await call();
    expect(res.status).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });
  it("passes the saved version on and reports unchanged", async () => {
    const f = vi.fn(async () => reply(null, { status: 304 }));
    vi.stubGlobal("fetch", f);
    const res = await call({ body: JSON.stringify({ etag: ETAG }) });
    expect(await res.json()).toEqual({ ok: true, status: "unchanged" });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "If-None-Match": ETAG });
  });
  it("rejects a bad or oversized request body", async () => {
    cqs(() => reply(exportText(1), { status: 200 }));
    expect((await call({ body: "{not json" })).status).toBe(400);
    expect((await call({ body: JSON.stringify({ etag: "x".repeat(5000) }) })).status).toBe(400);
  });
  it("limits how often one client can sync", async () => {
    cqs(() => reply(exportText(1), { status: 200 }));
    const same = () => POST(new Request("https://vqs.example.com/api/bank/sync", { method: "POST", headers: { "x-forwarded-for": "198.51.100.77", "x-teacher-passcode": PASS }, body: "{}" }));
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await same()).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe("accepting a synchronized bank", () => {
  const saved = (count: number): SavedBank => {
    const e = evaluateSync(null, exportText(count), ETAG);
    if (!e.ok) throw new Error(e.error);
    return e.incoming;
  };
  it("the first sync is accepted and remembers when it happened and its version", () => {
    const e = evaluateSync(null, exportText(10), ETAG, new Date("2026-11-14T09:30:00Z"));
    expect(e).toMatchObject({ ok: true, needsConfirm: false, readyBefore: null, readyAfter: 10 });
    if (!e.ok) return;
    expect(e.incoming).toMatchObject({ origin: "sync", syncedAt: "2026-11-14T09:30:00.000Z", etag: ETAG });
    const s = memory();
    expect(saveBank(s, e.incoming)).toBe(true);
    expect(loadBank(s)).toMatchObject({ origin: "sync", syncedAt: "2026-11-14T09:30:00.000Z", etag: ETAG });
    expect(convertBank(loadBank(s)!).counts.ready).toBe(10);
  });
  it("uses the existing converter and filters: the counts are the real ready/flagged/skipped numbers", () => {
    const flagged = JSON.parse(exportText(1)).questions[0];
    flagged.prompt = "Who is this?";
    const text = JSON.stringify({ format: "classroom-quiz-show/questions", version: 1, questions: [...JSON.parse(exportText(4)).questions, flagged, { ...question(), status: "draft" }] });
    const e = evaluateSync(null, text, undefined);
    expect(e.ok && e.counts).toMatchObject({ total: 6, ready: 4, flagged: 1, skipped: 1 });
  });
  it("a bank with more than 50% fewer ready questions needs an explicit yes; exactly half does not", () => {
    const current = saved(100);
    expect(SHRINK_CONFIRM_BELOW).toBe(0.5);
    expect(evaluateSync(current, exportText(49), undefined)).toMatchObject({ ok: true, needsConfirm: true, readyBefore: 100, readyAfter: 49 });
    expect(evaluateSync(current, exportText(50), undefined)).toMatchObject({ ok: true, needsConfirm: false });
    expect(evaluateSync(current, exportText(120), undefined)).toMatchObject({ ok: true, needsConfirm: false });
    expect(evaluateSync(current, exportText(0), undefined)).toMatchObject({ ok: true, needsConfirm: true, readyAfter: 0 }); // empty bank over a good one
  });
  it("an unusable bank never replaces anything", () => {
    expect(evaluateSync(null, exportText(0), undefined)).toMatchObject({ ok: false });
    expect(evaluateSync(saved(10), "garbage", undefined)).toMatchObject({ ok: false });
    expect(evaluateSync(saved(10), JSON.stringify({ format: "classroom-quiz-show/questions", version: 2, questions: [] }), undefined)).toMatchObject({ ok: false });
  });
  it("evaluating changes nothing that is saved: only an explicit save replaces the bank", () => {
    const s = memory();
    const current = saved(100);
    saveBank(s, current);
    const before = s.data[BANK_KEY];
    evaluateSync(current, exportText(5), undefined);
    evaluateSync(current, "garbage", undefined);
    expect(s.data[BANK_KEY]).toBe(before);
    expect(loadBank(s)!.questions).toHaveLength(100);
  });
  it("an unchanged answer keeps the questions and only records the new check time", () => {
    const s = memory();
    const current = saved(7);
    const m = markSynced(s, current, new Date("2026-11-15T00:00:00Z"));
    expect(m.bank.questions).toBe(current.questions);
    expect(loadBank(s)).toMatchObject({ syncedAt: "2026-11-15T00:00:00.000Z", etag: ETAG });
    expect(loadBank(s)!.questions).toHaveLength(7);
  });
  it("a browser that will not store the bank still gets a working one", () => {
    expect(saveBank({ getItem: () => null, setItem: () => { throw new Error("full"); } }, saved(3))).toBe(false);
  });
});

describe("the browser never holds the secret", () => {
  it("the client calls only this app's own route and sends no token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { status: 200, json: async () => ({ ok: true, status: "unchanged" }) }; }) as unknown as typeof fetch;
    expect(await requestLatestBank(ETAG, f)).toEqual({ kind: "unchanged" });
    expect(calls[0].url).toBe("/api/bank/sync");
    expect(JSON.stringify(calls[0].init)).not.toMatch(/Bearer|CQS_SYNC_TOKEN/);
    expect(await requestLatestBank(undefined, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toMatchObject({ kind: "error" });
  });
  it("no client file mentions the token, process.env or the Classroom Quiz Show address", () => {
    for (const f of ["../../components/class/BankHost.tsx", "./cqsSync.ts", "./cqsBank.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/CQS_SYNC_TOKEN|process\.env|classroom-quiz-show\.vercel\.app|Bearer/);
    }
    expect(readFileSync(new URL("../../components/class/BankHost.tsx", import.meta.url), "utf8")).toMatch(/Sync Latest Bank/);
  });
});

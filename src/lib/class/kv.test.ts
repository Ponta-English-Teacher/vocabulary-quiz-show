import { afterEach, describe, expect, it, vi } from "vitest";
import { KvConfigError, KvError, MemoryKV, UpstashKV, kvFromEnv, versionOf } from "./kv";

const TOKEN = "TEST-TOKEN-not-real";
const URL_ = "https://example-db.upstash.io";
/** Fake Upstash REST endpoint: records every request, replies from a queue. */
function fakeUpstash(...replies: (unknown | Response)[]) {
  const calls: { url: string; auth: string | null; body: unknown; method: string }[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, body: JSON.parse(String(init.body)), method: String(init.method) });
    const r = replies[Math.min(i++, replies.length - 1)];
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  });
  return { kv: new UpstashKV(URL_, TOKEN, fetchImpl as never), calls, fetchImpl };
}

describe("Upstash REST wire format", () => {
  it("GET and SET are JSON-array POSTs with a Bearer token and an expiry", async () => {
    const { kv, calls } = fakeUpstash({ result: "3|{}" }, { result: "OK" });
    expect(await kv.get("k1")).toBe("3|{}");
    await kv.set("k2", "v", 15);
    expect(calls[0]).toEqual({ url: URL_, auth: `Bearer ${TOKEN}`, method: "POST", body: ["GET", "k1"] });
    expect(calls[1].body).toEqual(["SET", "k2", "v", "EX", 15]);
  });
  it("a missing key is null", async () => {
    expect(await fakeUpstash({ result: null }).kv.get("nope")).toBeNull();
  });
  it("a trailing slash on the URL doesn't matter", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 }));
    await new UpstashKV(`${URL_}/`, TOKEN, f as never).get("x");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(URL_);
  });
  it("pipeline sends one request to /pipeline and maps results in order", async () => {
    const { kv, calls } = fakeUpstash([{ result: "OK" }, { result: 1 }, { result: "1|{}" }]);
    const out = await kv.pipeline([
      { op: "set", key: "p1", value: "1", ttl: 15 },
      { op: "exists", key: "p2" },
      { op: "get", key: "room" },
    ]);
    expect(out).toEqual([null, 1, "1|{}"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${URL_}/pipeline`);
    expect(calls[0].body).toEqual([["SET", "p1", "1", "EX", 15], ["EXISTS", "p2"], ["GET", "room"]]);
  });
  it("compare-and-set runs an atomic Lua script keyed on the stored version", async () => {
    const { kv, calls } = fakeUpstash({ result: 1 }, { result: 0 });
    expect(await kv.cas("room", 4, "5|{...}", 21600)).toBe(true);
    expect(await kv.cas("room", 4, "5|{...}", 21600)).toBe(false);
    const [cmd, script, numKeys, key, expected, value, ttl] = calls[0].body as [string, string, number, string, number, string, number];
    expect([cmd, numKeys, key, expected, value, ttl]).toEqual(["EVAL", 1, "room", 4, "5|{...}", 21600]);
    expect(script).toMatch(/redis\.call\('GET', KEYS\[1\]\)/);
    expect(script).toMatch(/redis\.call\('SET', KEYS\[1\], ARGV\[2\], 'EX', ARGV\[3\]\)/);
    expect(script).toMatch(/expected ~= 0/); // creating requires "does not exist"
  });
  it("counters use INCR + EXPIRE in one pipeline", async () => {
    const { kv, calls } = fakeUpstash([{ result: 7 }, { result: 1 }]);
    expect(await kv.incr("c", 600)).toBe(7);
    expect(calls[0].body).toEqual([["INCR", "c"], ["EXPIRE", "c", 600]]);
  });
});

describe("failures never leak the token or the response body", () => {
  const leaks = (e: unknown) => JSON.stringify(String((e as Error).message)).includes(TOKEN) || /secret-upstream-body/.test(String((e as Error).message));
  it("HTTP errors become a generic KvError", async () => {
    const { kv } = fakeUpstash(new Response("secret-upstream-body " + TOKEN, { status: 401 }));
    const e = await kv.get("k").catch((x) => x);
    expect(e).toBeInstanceOf(KvError);
    expect(e.message).toMatch(/HTTP 401/);
    expect(leaks(e)).toBe(false);
  });
  it("Redis error replies, bad JSON, malformed pipelines and network failures are all KvErrors", async () => {
    expect(await fakeUpstash({ error: "ERR boom " + TOKEN }).kv.get("k").catch((x) => x)).toBeInstanceOf(KvError);
    expect(await fakeUpstash(new Response("<html>", { status: 200 })).kv.get("k").catch((x) => x)).toBeInstanceOf(KvError);
    expect(await fakeUpstash({ not: "an array" }).kv.pipeline([{ op: "get", key: "a" }]).catch((x) => x)).toBeInstanceOf(KvError);
    expect(await fakeUpstash([{ error: "ERR" }]).kv.pipeline([{ op: "get", key: "a" }]).catch((x) => x)).toBeInstanceOf(KvError);
    const down = new UpstashKV(URL_, TOKEN, (async () => { throw new TypeError("fetch failed " + TOKEN); }) as never);
    const e = await down.get("k").catch((x) => x);
    expect(e).toBeInstanceOf(KvError);
    expect(leaks(e)).toBe(false);
  });
});

describe("choosing the storage", () => {
  afterEach(() => { delete (globalThis as { __vqsMemoryKv?: unknown }).__vqsMemoryKv; });
  it("uses Upstash when its variables are present (either naming the Vercel integration may use)", () => {
    expect(kvFromEnv({ UPSTASH_REDIS_REST_URL: URL_, UPSTASH_REDIS_REST_TOKEN: TOKEN })).toBeInstanceOf(UpstashKV);
    expect(kvFromEnv({ KV_REST_API_URL: URL_, KV_REST_API_TOKEN: TOKEN })).toBeInstanceOf(UpstashKV);
    expect(kvFromEnv({ VERCEL: "1", KV_REST_API_URL: URL_, KV_REST_API_TOKEN: TOKEN })).toBeInstanceOf(UpstashKV);
  });
  it("on Vercel without configuration it refuses, instead of silently splitting groups across instances", () => {
    expect(() => kvFromEnv({ VERCEL: "1" })).toThrow(KvConfigError);
    expect(() => kvFromEnv({ VERCEL: "1", UPSTASH_REDIS_REST_URL: URL_ })).toThrow(KvConfigError); // URL without token
  });
  it("on a laptop without configuration it uses one shared in-memory store", () => {
    const a = kvFromEnv({});
    expect(a).toBeInstanceOf(MemoryKV);
    expect(kvFromEnv({})).toBe(a);
  });
});

describe("MemoryKV matches the Redis semantics the service relies on", () => {
  it("expires keys, versioned compare-and-set, and counters", async () => {
    let now = 0;
    const kv = new MemoryKV(() => now);
    expect(await kv.cas("r", 0, "1|a", 60)).toBe(true);
    expect(await kv.cas("r", 0, "1|b", 60)).toBe(false); // already exists
    expect(await kv.cas("r", 2, "3|c", 60)).toBe(false); // wrong version
    expect(await kv.cas("r", 1, "2|d", 60)).toBe(true);
    expect(await kv.get("r")).toBe("2|d");
    await kv.set("p", "1", 15);
    expect((await kv.pipeline([{ op: "exists", key: "p" }]))[0]).toBe(1);
    now += 16_000;
    expect((await kv.pipeline([{ op: "exists", key: "p" }]))[0]).toBe(0);
    expect(await kv.incr("n", 10)).toBe(1);
    expect(await kv.incr("n", 10)).toBe(2);
    now += 11_000;
    expect(await kv.incr("n", 10)).toBe(1);
  });
  it("reads the version prefix", () => {
    expect(versionOf("12|{}")).toBe(12);
    expect(versionOf(null)).toBe(0);
    expect(versionOf("garbage")).toBe(0);
  });
});

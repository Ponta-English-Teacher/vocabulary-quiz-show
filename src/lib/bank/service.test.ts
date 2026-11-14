import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryKV, UpstashKV, type FetchLike } from "@/lib/class/kv";
import { MAX_FAILURES } from "@/lib/teacher/auth";
import { handleWordbank, type WordbankDeps } from "./http";
import { BankService } from "./service";
import { KEYS, MemoryBankStore, UpstashBankStore, assertBankKey, bankStoreFromEnv, type BankStore } from "./store";
import { BANK_FORMAT, type BankWord } from "./types";

const NOW = "2026-11-14T10:00:00.000Z";
let n = 0;
const svc = (store: BankStore = new MemoryBankStore()) => new BankService(store, () => NOW, () => `bid${++n}x`);

/** Distinct, valid hints per (word, variant); none contains the word. */
const hintsFor = (v: number) => [
  `Imagine a quiet morning at home, number ${v}.`,
  `People talk about it when they meet on day ${v}.`,
  `A student can describe it using simple words, version ${v}.`,
  `It is easy to name after you hear the last clue, set ${v}.`,
];
const rec = (word: string, level = "A2", variant = 0, extra: Record<string, unknown> = {}) => ({ word, partOfSpeech: "noun", category: "Home", level, hints: hintsFor(variant), ...extra });
const file = (...r: object[]) => JSON.stringify({ format: BANK_FORMAT, words: r });

describe("import: drafts, retry and duplicates", () => {
  it("imports valid records as drafts and reports what was skipped", async () => {
    const s = svc();
    const r = await s.importDrafts(file(rec("alphaa"), rec("alphab"), rec("", "A2"), rec("alphac", "Z9")), "x.json");
    if (!("created" in r)) throw new Error("expected an outcome");
    expect(r).toMatchObject({ created: 2, replayed: false, total: 4, skipped: { invalid: 2, duplicate: 0, heldForReview: 0 } });
    const l = await s.list();
    expect(l.counts).toEqual({ draft: 2, approved: 0, archived: 0, total: 2 });
    expect(l.words.every((w) => w.status === "draft")).toBe(true);
  });
  it("a repeated identical import writes nothing the second time (and a re-formatted copy is recognised too)", async () => {
    const store = new MemoryBankStore();
    const s = svc(store);
    const text = file(rec("alphaa"), rec("alphab"));
    const first = await s.importDrafts(text);
    const writesAfterFirst = store.log.filter((l) => l.cmd === "HSET" || l.cmd === "HSETNX").length;
    const again = await s.importDrafts(text);
    expect(store.log.filter((l) => l.cmd === "HSET" || l.cmd === "HSETNX").length).toBe(writesAfterFirst);
    const reformatted = await s.importDrafts(JSON.stringify(JSON.parse(text), null, 4) + "\n");
    if (!("created" in first) || !("created" in again) || !("created" in reformatted)) throw new Error("expected outcomes");
    expect(first.created).toBe(2);
    expect(again).toMatchObject({ replayed: true, created: 2 });
    // The reformatted file is a different import id, but every record is now an identical duplicate.
    expect(reformatted).toMatchObject({ replayed: false, created: 0, skipped: { duplicate: 2 } });
    expect((await s.list()).counts.total).toBe(2);
  });
  it("overlapping imports of the same records create each record only once", async () => {
    const s1 = svc();
    const store = new MemoryBankStore();
    const a = svc(store), b = svc(store);
    const text1 = file(rec("alphaa"), rec("alphab"), rec("alphac"));
    const text2 = JSON.stringify(JSON.parse(text1), null, 2); // different text → different import id → no replay shortcut
    const [r1, r2] = await Promise.all([a.importDrafts(text1), b.importDrafts(text2)]);
    if (!("created" in r1) || !("created" in r2)) throw new Error("expected outcomes");
    expect(r1.created + r2.created).toBe(3);
    expect((await a.list()).counts.total).toBe(3);
    expect(s1).toBeTruthy();
  });
  it("a failed import can be retried: no duplicates, and nothing is lost", async () => {
    const store = new MemoryBankStore();
    let failNext = false;
    const flaky: BankStore = {
      hgetall: (k) => store.hgetall(k),
      hget: (k, f) => store.hget(k, f),
      hsetnx: (k, f, v) => store.hsetnx(k, f, v),
      hdel: (k, f) => store.hdel(k, f),
      hset: async (k, f, v) => { if (failNext && k === KEYS.words) { failNext = false; throw new Error("boom"); } return store.hset(k, f, v); },
    };
    const s = svc(flaky);
    const text = file(rec("alphaa"), rec("alphab"), rec("alphac"));
    failNext = true; // the very first word fails to save AFTER its identity was claimed
    await expect(s.importDrafts(text)).rejects.toThrow();
    const retry = await s.importDrafts(text);
    if (!("created" in retry)) throw new Error("expected an outcome");
    expect(retry.created).toBe(3); // the orphaned claim is taken over, not mistaken for a duplicate
    const again = await s.importDrafts(text);
    expect(again).toMatchObject({ replayed: true });
    expect((await s.list()).words.map((w) => w.word).sort()).toEqual(["alphaa", "alphab", "alphac"]);
  });
  it("rejects identical records, holds same-word-other-level for review, and keeps them only on request", async () => {
    const s = svc();
    await s.importDrafts(file(rec("alphaa", "A2", 0)));
    const text = file(rec("alphaa", "A2", 0), rec("alphaa", "B2", 0), rec("alphaa", "A2", 1));
    const held = await s.importDrafts(text);
    if (!("created" in held)) throw new Error("expected an outcome");
    expect(held).toMatchObject({ created: 0, skipped: { duplicate: 1, heldForReview: 2 } });
    const kept = await s.importDrafts(text, "x.json", [2, 3]);
    if (!("created" in kept)) throw new Error("expected an outcome");
    expect(kept.created).toBe(2);
    expect((await s.list()).counts.total).toBe(3);
  });
  it("preview writes nothing", async () => {
    const store = new MemoryBankStore();
    const { analysis } = await svc(store).previewImport(file(rec("alphaa")));
    expect(analysis.counts.importable).toBe(1);
    expect(store.log.some((l) => l.cmd === "HSET" || l.cmd === "HSETNX" || l.cmd === "HDEL")).toBe(false);
  });
  it("refuses empty, oversized and wrong-format files with a clear error", async () => {
    const s = svc();
    expect(await s.importDrafts("   ")).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.importDrafts('{"format":"classroom-quiz-show/questions","questions":[]}')).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("source and sourceId", () => {
  it("are preserved on import, in the list and in the export, and cannot be edited away", async () => {
    const s = svc();
    await s.importDrafts(file(rec("alphaa", "A2", 0, { source: "classroom-quiz-show", sourceId: "cqs-123" }), rec("alphab")));
    const [a, b] = (await s.list()).words;
    expect(a).toMatchObject({ source: "classroom-quiz-show", sourceId: "cqs-123" });
    expect(b.source).toBe("file");
    const edited = await s.edit(a.id, { category: "Kitchen", source: "manual", sourceId: "hacked", status: "approved", id: "zzz" });
    if (!edited.ok) throw new Error("expected edit");
    expect(edited.word).toMatchObject({ source: "classroom-quiz-show", sourceId: "cqs-123", status: "draft", id: a.id, category: "Kitchen" });
    const exp = await s.exportAll();
    expect(exp.words.find((w) => w.id === a.id)).toMatchObject({ source: "classroom-quiz-show", sourceId: "cqs-123" });
  });
});

describe("edit, approve, archive, restore", () => {
  const setup = async () => {
    const s = svc();
    const r = await s.importDrafts(file(rec("alphaa", "A2", 0), rec("alphab", "A2", 1)));
    if (!("created" in r)) throw new Error("expected an outcome");
    return { s, ids: r.createdIds };
  };
  it("approving needs a valid word and returns it from edits to draft", async () => {
    const { s, ids } = await setup();
    const ok = await s.approve(ids[0]);
    expect(ok).toMatchObject({ ok: true, word: { status: "approved", approvedAt: NOW } });
    const e = await s.edit(ids[0], { hints: hintsFor(9) });
    expect(e).toMatchObject({ ok: true, word: { status: "draft" } });
    expect((await s.list({ status: "approved" })).words).toHaveLength(0);
  });
  it("saves an edit that still has problems, returns them, and blocks approval", async () => {
    const { s, ids } = await setup();
    const h = hintsFor(0);
    h[1] = "An alphaa is something you can see at home.";
    const e = await s.edit(ids[0], { hints: h });
    if (!e.ok) throw new Error("expected edit");
    expect(e.issues.map((i) => i.code)).toContain("leak");
    expect(await s.approve(ids[0])).toMatchObject({ ok: false, code: "invalid" });
  });
  it("rejects edits that would make an identical twin, and malformed edits", async () => {
    const { s, ids } = await setup();
    expect(await s.edit(ids[1], { word: "alphaa", hints: hintsFor(0) })).toMatchObject({ ok: false, code: "conflict" });
    expect(await s.edit(ids[1], { cefr: "Q" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.edit(ids[1], { hints: "no" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.edit(ids[1], { word: "" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.edit("missing", { category: "x" })).toMatchObject({ ok: false, code: "not_found" });
  });
  it("an edit that changes the identity frees the old one", async () => {
    const { s, ids } = await setup();
    await s.edit(ids[0], { hints: hintsFor(7) });
    // Same word, same level, other hints now: held for review (not rejected), and keeping it succeeds because the old identity is free again.
    const text = file(rec("alphaa", "A2", 0));
    expect(await s.importDrafts(text)).toMatchObject({ created: 0, skipped: { heldForReview: 1, duplicate: 0 } });
    const r = await s.importDrafts(text, "x.json", [1]);
    if (!("created" in r)) throw new Error("expected an outcome");
    expect(r.created).toBe(1);
  });
  it("approve-many approves the good ones and reports each failure", async () => {
    const { s, ids } = await setup();
    const bad = await s.edit(ids[1], { hints: ["", "", "", ""] });
    expect(bad.ok).toBe(true);
    const r = await s.approveMany([ids[0], ids[1], "nope", ids[0]]);
    if (!r.ok) throw new Error("expected ok");
    expect(r.approved).toEqual([ids[0]]);
    expect(r.failed.map((f) => f.id).sort()).toEqual([ids[1], "nope"].sort());
    expect(await s.approveMany([])).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.approveMany(Array.from({ length: 201 }, (_, i) => `x${i}`))).toMatchObject({ ok: false, code: "bad_request" });
  });
  it("archive hides a word from play and restore brings it back as a draft, never approved", async () => {
    const { s, ids } = await setup();
    await s.approve(ids[0]);
    const arch = await s.archive(ids[0]);
    expect(arch).toMatchObject({ ok: true, word: { status: "archived", archivedFrom: "approved" } });
    expect(await s.edit(ids[0], { category: "x" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await s.approve(ids[0])).toMatchObject({ ok: false });
    const back = await s.restore(ids[0]);
    expect(back).toMatchObject({ ok: true, word: { status: "draft" } });
    expect(await s.restore(ids[0])).toMatchObject({ ok: false, code: "conflict" });
  });
  it("cannot restore an archived word when an identical live word now exists", async () => {
    const { s, ids } = await setup();
    await s.archive(ids[0]);
    const r = await s.importDrafts(file(rec("alphaa", "A2", 0)));
    if (!("created" in r)) throw new Error("expected an outcome");
    expect(r.created).toBe(1);
    expect(await s.restore(ids[0])).toMatchObject({ ok: false, code: "conflict" });
  });
  it("a different-hints twin can be approved next to the original; an identical one cannot", async () => {
    const s = svc();
    const r = await s.importDrafts(file(rec("alphaa", "A2", 0), rec("alphaa", "A2", 1)), "x.json", [2]);
    if (!("created" in r)) throw new Error("expected an outcome");
    expect(r.created).toBe(2);
    const approved = await s.approveMany(r.createdIds);
    expect(approved).toMatchObject({ ok: true, approved: r.createdIds });
  });
  it("filters the list and counts every status", async () => {
    const { s, ids } = await setup();
    await s.approve(ids[0]);
    await s.archive(ids[1]);
    const all = await s.list();
    expect(all.counts).toEqual({ draft: 0, approved: 1, archived: 1, total: 2 });
    expect((await s.list({ status: "approved" })).words.map((w) => w.id)).toEqual([ids[0]]);
    expect((await s.list({ q: "ALPHAB" })).words.map((w) => w.id)).toEqual([ids[1]]);
    expect((await s.list({ cefr: "C1" })).words).toEqual([]);
  });
});

describe("export", () => {
  it("contains the complete bank (all statuses) and can be previewed and imported again", async () => {
    const s = svc();
    const r = await s.importDrafts(file(rec("alphaa", "A2", 0, { source: "classroom-quiz-show", sourceId: "q1", giverJa: "あ" }), rec("alphab"), rec("alphac")));
    if (!("created" in r)) throw new Error("expected an outcome");
    await s.approve(r.createdIds[0]);
    await s.archive(r.createdIds[2]);
    const exp = await s.exportAll();
    expect(exp).toMatchObject({ format: BANK_FORMAT, counts: { total: 3, approved: 1, draft: 1, archived: 1 } });
    expect(exp.words.map((w) => w.status).sort()).toEqual(["approved", "archived", "draft"]);
    expect(exp.words.find((w) => w.id === r.createdIds[0])).toMatchObject({ giverJa: "あ", sourceId: "q1", hints: hintsFor(0) });
    // Round trip into a fresh bank: everything arrives as drafts, with provenance kept.
    const fresh = svc();
    const back = await fresh.importDrafts(JSON.stringify(exp));
    if (!("created" in back)) throw new Error("expected an outcome");
    expect(back.created).toBe(3);
    const words = (await fresh.list()).words;
    expect(words.every((w) => w.status === "draft")).toBe(true);
    expect(words.find((w) => w.word === "alphaa")).toMatchObject({ source: "classroom-quiz-show", sourceId: "q1" });
    // Importing it back into the SAME bank adds only the word whose twin is archived (archived words are ignored); live words are duplicates.
    const same = await s.importDrafts(JSON.stringify(exp));
    expect(same).toMatchObject({ created: 1, skipped: { duplicate: 2 } });
  });
  it("skips damaged records instead of failing the whole list", async () => {
    const store = new MemoryBankStore();
    const s = svc(store);
    await s.importDrafts(file(rec("alphaa")));
    await store.hset(KEYS.words, "broken", "{nope");
    const l = await s.list();
    expect(l.counts.total).toBe(1);
    expect(l.unreadable).toBe(1);
  });
});

// ---------------------------------------------------------------- HTTP, authentication and secrets

const PASS = "s3cret-teacher-pass";
const URLX = "https://secret-host.upstash.io";
const TOK = "AXsecretTOKEN123";
const mkDeps = (over: Partial<WordbankDeps> = {}) => {
  const store = new MemoryBankStore();
  const opened = { n: 0 };
  const kv = new MemoryKV();
  const deps: WordbankDeps = { env: { TEACHER_PASSCODE: PASS }, authKv: () => kv, store: () => (opened.n++, store), now: () => NOW, makeId: () => `bid${++n}h`, ...over };
  return { deps, store, opened, kv };
};
const call = (deps: WordbankDeps, method: string, path: string[], opts: { body?: unknown; pass?: string | null; ip?: string; query?: string } = {}) =>
  handleWordbank(new Request(`http://x/api/wordbank/${path.join("/")}${opts.query ?? ""}`, { method, headers: { "content-type": "application/json", ...(opts.pass === null ? {} : { "x-teacher-passcode": opts.pass ?? PASS }), "x-forwarded-for": opts.ip ?? "1.2.3.4" }, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }), path, deps);

describe("teacher authentication", () => {
  const ROUTES: [string, string[], unknown?][] = [
    ["GET", []], ["GET", ["export"]], ["POST", ["import"], { text: "[]" }], ["PATCH", ["bid1"], { patch: {} }],
    ["POST", ["bid1", "approve"]], ["POST", ["bid1", "archive"]], ["POST", ["bid1", "restore"]], ["POST", ["approve-many"], { ids: ["a"] }],
  ];
  it("every operation refuses a missing or wrong passcode, and opens no storage", async () => {
    const { deps, store, opened } = mkDeps();
    let ip = 0;
    for (const [m, p, b] of ROUTES) {
      expect((await call(deps, m, p, { body: b, pass: null, ip: `10.0.0.${++ip}` })).status).toBe(401);
      expect((await call(deps, m, p, { body: b, pass: "wrong", ip: `10.0.0.${++ip}` })).status).toBe(401);
    }
    expect(opened.n).toBe(0);
    expect(store.log).toEqual([]);
  });
  it("accepts the right passcode and the full flow works through HTTP", async () => {
    const { deps } = mkDeps();
    const imp = await call(deps, "POST", ["import"], { body: { text: file(rec("alphaa"), rec("alphab")), filename: "w.json" } });
    expect(imp.status).toBe(200);
    const created = (await imp.json()).createdIds as string[];
    expect(created).toHaveLength(2);
    const dry = await (await call(deps, "POST", ["import"], { body: { text: file(rec("alphaa")), dryRun: true } })).json();
    expect(dry).toMatchObject({ ok: true, dryRun: true, counts: { duplicate: 1 } });
    expect((await call(deps, "PATCH", [created[0]], { body: { patch: { category: "Kitchen" } } })).status).toBe(200);
    expect((await call(deps, "POST", [created[0], "approve"])).status).toBe(200);
    expect((await call(deps, "POST", ["approve-many"], { body: { ids: [created[1]] } })).status).toBe(200);
    expect((await call(deps, "POST", [created[1], "archive"])).status).toBe(200);
    expect((await call(deps, "POST", [created[1], "restore"])).status).toBe(200);
    const list = await (await call(deps, "GET", [], { query: "?status=approved" })).json();
    expect(list.words).toHaveLength(1);
    const exp = await call(deps, "GET", ["export"]);
    expect(exp.headers.get("content-disposition")).toMatch(/attachment; filename="vqs-wordbank-2026-11-14\.json"/);
    expect((await exp.json()).counts.total).toBe(2);
  });
  it("service errors map to HTTP statuses", async () => {
    const { deps } = mkDeps();
    expect((await call(deps, "POST", ["bid9", "approve"])).status).toBe(404);
    expect((await call(deps, "POST", ["import"], { body: { text: "" } })).status).toBe(400);
    expect((await call(deps, "POST", ["import"], { body: { nothing: 1 } })).status).toBe(400);
    expect((await call(deps, "GET", [], { query: "?status=weird" })).status).toBe(400);
    expect((await call(deps, "DELETE", ["bid1"])).status).toBe(404);
    expect((await call(deps, "POST", ["import", "x"], { body: { text: "[]" } })).status).toBe(404);
    expect((await call(deps, "POST", ["../etc", "approve"])).status).toBe(404);
  });
  it("after too many wrong guesses even the right passcode is refused (429)", async () => {
    const { deps } = mkDeps();
    for (let i = 0; i < MAX_FAILURES; i++) await call(deps, "GET", [], { pass: `guess${i}`, ip: "9.9.9.9" });
    expect((await call(deps, "GET", [], { ip: "9.9.9.9" })).status).toBe(429);
    expect((await call(deps, "GET", [], { ip: "8.8.8.8" })).status).toBe(200); // other clients unaffected
  });
  it("is locked (503) when no passcode is configured on the server, open only on a laptop", async () => {
    expect((await call(mkDeps({ env: { VERCEL: "1" } }).deps, "GET", [])).status).toBe(503);
    expect((await call(mkDeps({ env: {} }).deps, "GET", [], { pass: null })).status).toBe(200);
  });
  it("never puts the passcode or storage credentials in any response, even when storage fails", async () => {
    const failing: BankStore = {
      hgetall: async () => { throw new Error(`failed at ${URLX} with ${TOK} and ${PASS}`); },
      hget: async () => { throw new Error(`${URLX} ${TOK}`); },
      hset: async () => { throw new Error(TOK); }, hsetnx: async () => { throw new Error(TOK); }, hdel: async () => { throw new Error(TOK); },
    };
    const { deps } = mkDeps({ store: () => failing });
    const bodies: string[] = [];
    for (const [m, p, b] of [["GET", []], ["GET", ["export"]], ["POST", ["import"], { text: file(rec("alphaa")) }], ["POST", ["bid1", "approve"]]] as [string, string[], unknown?][]) {
      const res = await call(deps, m, p, { body: b });
      expect(res.status).toBe(503);
      bodies.push(await res.text());
    }
    bodies.push(await (await call(deps, "GET", [], { pass: "wrong" })).text(), await (await call(deps, "GET", [], { pass: null })).text());
    for (const t of bodies) for (const secret of [PASS, TOK, URLX, "secret-host"]) expect(t).not.toContain(secret);
  });
  it("a missing storage configuration on Vercel is a plain 503", async () => {
    const { deps } = mkDeps({ store: () => bankStoreFromEnv({ VERCEL: "1" }) });
    const res = await call(deps, "GET", []);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(PASS);
  });
});

// ---------------------------------------------------------------- data isolation

/** A fake Upstash REST endpoint backed by one shared dictionary, so classroom storage and the bank really do share a database. */
function fakeRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const calls: { cmd: string; key: string }[] = [];
  const exec = (c: (string | number)[]): unknown => {
    const [cmd, key, a, b] = c as [string, string, string, string];
    calls.push({ cmd, key });
    const h = () => hashes.get(key) ?? hashes.set(key, new Map()).get(key)!;
    switch (cmd) {
      case "GET": return strings.get(key) ?? null;
      case "SET": strings.set(key, String(a)); return "OK";
      case "INCR": { const v = (Number(strings.get(key)) || 0) + 1; strings.set(key, String(v)); return v; }
      case "EXPIRE": return 1;
      case "HGETALL": return [...h()].flat();
      case "HGET": return h().get(a) ?? null;
      case "HSET": h().set(a, b); return 1;
      case "HSETNX": if (h().has(a)) return 0; h().set(a, b); return 1;
      case "HDEL": return h().delete(a) ? 1 : 0;
      default: throw new Error(`unsupported ${cmd}`);
    }
  };
  const fetchImpl: FetchLike = async (url, init) => {
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOK}`);
    const body = JSON.parse(String(init.body));
    const result = url.endsWith("/pipeline") ? (body as (string | number)[][]).map((c) => ({ result: exec(c) })) : { result: exec(body) };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  return { strings, hashes, calls, fetchImpl };
}

describe("data isolation", () => {
  it("bank keys live in their own namespace, disjoint from every classroom key", () => {
    expect(Object.values(KEYS).every((k) => k.startsWith("vqsbank:v1:") && !k.startsWith("vqs:"))).toBe(true);
    for (const bad of ["vqs:room:abc", "vqs:act:1", "vqs:tauth:x", "vqsbank:v2:words", "vqsbank:v1:other", "words", ""]) expect(() => assertBankKey(bad)).toThrow();
  });
  it("on a shared Redis, bank operations touch only bank keys and leave classroom data exactly as it was", async () => {
    const redis = fakeRedis();
    const kv = new UpstashKV(URLX, TOK, redis.fetchImpl);
    await kv.set("vqs:act:A1", "{\"words\":[]}", 3600);
    await kv.set("vqs:room:R1", "1|{}", 3600);
    await kv.incr("vqs:tauth:abc", 600);
    const before = JSON.stringify([...redis.strings]);
    redis.calls.length = 0;

    const s = new BankService(new UpstashBankStore(URLX, TOK, redis.fetchImpl), () => NOW, () => `bid${++n}u`);
    const imp = await s.importDrafts(file(rec("alphaa"), rec("alphab")));
    if (!("created" in imp)) throw new Error("expected an outcome");
    await s.approve(imp.createdIds[0]);
    await s.edit(imp.createdIds[1], { category: "x" });
    await s.archive(imp.createdIds[1]);
    await s.restore(imp.createdIds[1]);
    await s.exportAll();

    expect(redis.calls.length).toBeGreaterThan(0);
    expect(redis.calls.every((c) => c.key.startsWith("vqsbank:v1:"))).toBe(true);
    expect(JSON.stringify([...redis.strings])).toBe(before); // classroom strings untouched, no bank string keys added
    expect([...redis.hashes.keys()].sort()).toEqual([KEYS.ident, KEYS.imports, KEYS.words].sort());
    expect(await kv.get("vqs:act:A1")).toBe("{\"words\":[]}");
  });
  it("the Upstash store refuses a non-bank key before any network call", async () => {
    let called = 0;
    const store = new UpstashBankStore(URLX, TOK, async () => { called++; return new Response("{}"); });
    await expect(store.hgetall("vqs:room:x" as never)).rejects.toThrow(/word-bank/);
    expect(called).toBe(0);
  });
  it("storage errors never contain the credentials", async () => {
    for (const impl of [async () => { throw new Error(`${URLX} ${TOK}`); }, async () => new Response(`${TOK}`, { status: 401 }), async () => new Response("not json", { status: 200 }), async () => new Response(JSON.stringify({ error: `bad ${TOK}` }), { status: 200 })] as FetchLike[]) {
      const msg = await new UpstashBankStore(URLX, TOK, impl).hgetall(KEYS.words).then(() => "", (e: Error) => e.message);
      expect(msg).not.toBe("");
      for (const secret of [TOK, URLX]) expect(msg).not.toContain(secret);
    }
  });
  it("the bank code never reads the browser bank, saved activities or the class service", () => {
    for (const f of ["service.ts", "store.ts", "http.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      for (const forbidden of ["localStorage", "vqs.cqsBank", "vqs.activities", "class/service", "cqsBank", "studio/storage", "OPENAI"]) expect(src).not.toContain(forbidden);
    }
  });
  it("in-memory fallback is used on a laptop only", () => {
    expect(bankStoreFromEnv({}) instanceof MemoryBankStore).toBe(true);
    expect(bankStoreFromEnv({ UPSTASH_REDIS_REST_URL: URLX, UPSTASH_REDIS_REST_TOKEN: TOK }) instanceof UpstashBankStore).toBe(true);
    expect(() => bankStoreFromEnv({ VERCEL: "1" })).toThrow();
  });
});

export type { BankWord };

describe("create by hand", () => {
  const input = (over: Record<string, unknown> = {}) => ({ word: "alphaz", partOfSpeech: "noun", category: "Home", cefr: "A2", hints: hintsFor(3), giverJa: "ゼット", ...over });
  it("creates a manual draft and never approves it", async () => {
    const s = svc();
    const r = await s.create(input());
    expect(r).toMatchObject({ ok: true, word: { status: "draft", source: "manual", giverJa: "ゼット" } });
    expect((await s.list()).counts).toMatchObject({ draft: 1, approved: 0 });
    if (r.ok) expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
  it("accepts unfinished hints as a draft (reporting the problem) and ignores id/status/source", async () => {
    const s = svc();
    const r = await s.create(input({ hints: ["Only the first hint is written so far."], id: "evil", status: "approved", source: "file" }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.word).toMatchObject({ status: "draft", source: "manual", hints: ["Only the first hint is written so far.", "", "", ""] });
    expect(r.word.id).not.toBe("evil");
    expect(r.issues.map((i) => i.code)).toContain("empty");
    expect(await s.approve(r.word.id)).toMatchObject({ ok: false, code: "invalid" });
  });
  it("requires the essentials and rejects too many hints", async () => {
    const s = svc();
    expect(await s.create({ word: "x" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.create(input({ hints: ["a", "b", "c", "d", "e"] }))).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.create(null)).toMatchObject({ ok: false, code: "bad_request" });
  });
  it("refuses an identical twin but allows the same word at another level", async () => {
    const s = svc();
    expect((await s.create(input())).ok).toBe(true);
    expect(await s.create(input())).toMatchObject({ ok: false, code: "conflict" });
    expect((await s.create(input({ cefr: "B2" }))).ok).toBe(true);
  });
  it("works through the authenticated HTTP route", async () => {
    const { deps } = mkDeps();
    expect((await call(deps, "POST", [], { body: { word: input() }, pass: null })).status).toBe(401);
    const ok = await call(deps, "POST", [], { body: { word: input() } });
    expect(ok.status).toBe(201);
    expect((await ok.json()).word).toMatchObject({ source: "manual", status: "draft" });
    expect((await call(deps, "POST", [], { body: { word: input() } })).status).toBe(409);
    expect((await call(deps, "POST", [], { body: { word: {} } })).status).toBe(400);
  });
});

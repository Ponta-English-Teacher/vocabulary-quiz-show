import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryKV } from "@/lib/class/kv";
import { makeApi } from "./client";
import { handleWordbank, type WordbankDeps } from "./http";
import { BankService } from "./service";
import { MemoryBankStore } from "./store";
import { BANK_FORMAT, type BankWord } from "./types";
import { archivableDrafts, archiveConfirmMessage } from "./view";

const NOW = "2026-11-15T10:00:00.000Z";
let n = 0;
const mkSvc = (store = new MemoryBankStore()) => new BankService(store, () => NOW, () => `bid${++n}x`);
const hints = (v: string) => [`Imagine a quiet morning at home, ${v}.`, `People talk about it when they meet, ${v}.`, `A student can describe it in simple words, ${v}.`, `It is easy to name after the last clue, ${v}.`];
// Hints must not contain the word, so the variant tag is built from the word's letters shifted to digits.
const tag = (w: string) => [...w].map((c) => c.charCodeAt(0) % 10).join("");
const rec = (word: string, extra: Record<string, unknown> = {}) => ({ word, partOfSpeech: "noun", category: "Home", level: "A1", hints: hints(tag(word)), ...extra });
const file = (...r: object[]) => JSON.stringify({ format: BANK_FORMAT, words: r });

/** 2 approved pilot words + a batch of drafts, via the real service on the in-memory store. */
async function setup(drafts = 6) {
  const store = new MemoryBankStore();
  const s = mkSvc(store);
  const pilot = await s.importDrafts(file(rec("pilotone", { level: "B1", openingQuestion: "This is a place. What is it?" }), rec("pilottwo", { level: "A2" })), "pilot.json");
  if (!("createdIds" in pilot)) throw new Error("pilot");
  const ap = await s.approveMany(pilot.createdIds); expect((await s.approveMany(pilot.createdIds)).ok).toBe(true);
  const batch = await s.importDrafts(file(...Array.from({ length: drafts }, (_, i) => rec(`alpha${String.fromCharCode(97 + i)}x`))), "batch.json");
  if (!("createdIds" in batch)) throw new Error("batch");
  return { store, s, pilotIds: pilot.createdIds, draftIds: batch.createdIds, batchText: file(...Array.from({ length: drafts }, (_, i) => rec(`alpha${String.fromCharCode(97 + i)}x`))) };
}
const byId = async (s: BankService) => Object.fromEntries((await s.list()).words.map((w) => [w.id, w]));

describe("archiveDrafts (service)", () => {
  it("archives exactly the selected drafts and refreshes the counts", async () => {
    const { s, draftIds, pilotIds } = await setup(6);
    expect((await s.list()).counts).toEqual({ draft: 6, approved: 2, archived: 0, total: 8 });
    const r = await s.archiveDrafts(draftIds.slice(0, 4));
    expect(r).toEqual({ ok: true, archived: draftIds.slice(0, 4) });
    expect((await s.list()).counts).toEqual({ draft: 2, approved: 2, archived: 4, total: 8 });
    const all = await byId(s);
    for (const id of draftIds.slice(0, 4)) expect(all[id]).toMatchObject({ status: "archived", archivedFrom: "draft" });
    for (const id of draftIds.slice(4)) expect(all[id].status).toBe("draft");
    for (const id of pilotIds) expect(all[id].status).toBe("approved");
  });

  it("is all-or-nothing: one approved word (or an archived or missing one) refuses the whole request and changes nothing", async () => {
    const { s, store, draftIds, pilotIds } = await setup(5);
    await s.archive(draftIds[4]); // already archived
    const before = JSON.stringify(await byId(s));
    store.log.length = 0;
    for (const bad of [pilotIds[0], draftIds[4], "nope"]) {
      const r = await s.archiveDrafts([draftIds[0], draftIds[1], bad]);
      expect(r).toMatchObject({ ok: false, code: "conflict" });
      if (r.ok) throw new Error("expected refusal");
      expect(r.rejected.map((x) => x.id)).toEqual([bad]);
      expect(r.message).toContain("Nothing was archived");
    }
    expect(JSON.stringify(await byId(s))).toBe(before);
    expect(store.log.filter((l) => l.cmd !== "HGETALL" && l.cmd !== "HGET")).toEqual([]); // no writes at all
  });

  it("rejects an empty, malformed or oversized request", async () => {
    const { s } = await setup(2);
    for (const bad of [undefined, [], "x", [1], [null]]) expect(await s.archiveDrafts(bad)).toMatchObject({ ok: false, code: "bad_request" });
    expect(await s.archiveDrafts(Array.from({ length: 201 }, (_, i) => `x${i}`))).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("repeated ids are archived once", async () => {
    const { s, draftIds } = await setup(3);
    expect(await s.archiveDrafts([draftIds[0], draftIds[0]])).toEqual({ ok: true, archived: [draftIds[0]] });
  });

  it("approved words are byte-for-byte unchanged, and so are the archived drafts' content and hints", async () => {
    const { s, draftIds, pilotIds } = await setup(4);
    const before = await byId(s);
    await s.archiveDrafts(draftIds);
    const after = await byId(s);
    for (const id of pilotIds) expect(after[id]).toEqual(before[id]);
    for (const id of draftIds) {
      const { status: _s, updatedAt: _u, archivedFrom: _f, ...rest } = after[id];
      const { status: _s2, updatedAt: _u2, ...orig } = before[id];
      void [_s, _u, _f, _s2, _u2];
      expect(rest).toEqual(orig); // word, accept, hints, source, sourceId, createdAt …
    }
  });

  it("restore works afterwards (as a draft), and the export still lists every word", async () => {
    const { s, draftIds } = await setup(3);
    await s.archiveDrafts(draftIds);
    expect((await s.restore(draftIds[0])).ok).toBe(true);
    expect((await byId(s))[draftIds[0]].status).toBe("draft");
    expect((await s.exportAll()).words).toHaveLength(5);
  });

  it("import history and duplicate handling are preserved", async () => {
    const { s, store, draftIds, batchText } = await setup(4);
    const importsBefore = JSON.stringify(await store.hgetall("vqsbank:v1:imports"));
    await s.archiveDrafts(draftIds);
    expect(JSON.stringify(await store.hgetall("vqsbank:v1:imports"))).toBe(importsBefore); // import history untouched
    // The same file again is still recognised as already imported: it writes nothing.
    const again = await s.importDrafts(batchText, "batch.json");
    expect(again).toMatchObject({ replayed: true });
    expect((await s.list()).counts.total).toBe(6);
    // A corrected file (different hints) imports normally: archived words never count as duplicates.
    const fixed = await s.importDrafts(file(rec("alphaax", { hints: hints("revised copy") })), "fixed.json");
    expect(fixed).toMatchObject({ created: 1, skipped: { duplicate: 0 } });
    // Identical live words are still rejected.
    const dup = await s.importDrafts(file(rec("pilotone", { level: "B1" }), rec("zebrax")), "dup.json");
    expect(dup).toMatchObject({ created: 1 });
  });
});

describe("POST /api/wordbank/archive-drafts (HTTP, mock Redis store)", () => {
  const PASS = "pass-123";
  const mk = async () => {
    const { store, draftIds, pilotIds } = await setup(3);
    const kv = new MemoryKV();
    const deps: WordbankDeps = { env: { TEACHER_PASSCODE: PASS }, authKv: () => kv, store: () => store, now: () => NOW, makeId: () => `bid${++n}h` };
    const call = (ids: unknown, pass: string | null = PASS) => handleWordbank(new Request("http://x/api/wordbank/archive-drafts", { method: "POST", headers: { "content-type": "application/json", ...(pass ? { "x-teacher-passcode": pass } : {}), "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify({ ids }) }), ["archive-drafts"], deps);
    return { store, draftIds, pilotIds, call };
  };
  it("needs the teacher passcode and touches no storage without it", async () => {
    const { store, draftIds, call } = await mk();
    store.log.length = 0;
    expect((await call(draftIds, null)).status).toBe(401);
    expect(store.log).toEqual([]);
  });
  it("archives drafts (200) and refuses an approved word with 409 and no change", async () => {
    const { draftIds, pilotIds, call, store } = await mk();
    const refused = await call([draftIds[0], pilotIds[0]]);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toContain("Nothing was archived");
    expect((await new BankService(store).list()).counts).toEqual({ draft: 3, approved: 2, archived: 0, total: 5 });
    const ok = await call(draftIds);
    expect(ok.status).toBe(200);
    expect((await ok.json()).archived).toEqual(draftIds);
    expect((await new BankService(store).list()).counts).toEqual({ draft: 0, approved: 2, archived: 3, total: 5 });
  });
  it("a bad request is 400", async () => {
    const { call } = await mk();
    expect((await call([])).status).toBe(400);
  });
  it("the client sends exactly one request to the right route", async () => {
    const seen: string[] = [];
    const api = makeApi({ fetchImpl: async (u, i) => { seen.push(`${i?.method} ${String(u)} ${i?.body}`); return new Response(JSON.stringify({ ok: true, archived: ["a"] }), { status: 200 }); } });
    await api.archiveDrafts(["a"]);
    expect(seen).toEqual(['POST /api/wordbank/archive-drafts {"ids":["a"]}']);
  });
});

describe("selection and confirmation (UI logic)", () => {
  const w = (id: string, status: BankWord["status"]) => ({ id, word: id, status }) as BankWord;
  const all = [w("d1", "draft"), w("d2", "draft"), w("a1", "approved"), w("x1", "archived")];
  it("only drafts can be selected for archiving; approved and archived are dropped even if selected", () => {
    expect(archivableDrafts(all, new Set(["d1", "a1", "x1"])).map((x) => x.id)).toEqual(["d1"]);
    expect(archivableDrafts(all, new Set())).toEqual([]);
  });
  it("the confirmation states the exact number", () => {
    expect(archiveConfirmMessage(50)).toContain("Archive 50 selected drafts?");
    expect(archiveConfirmMessage(1)).toContain("Archive 1 selected draft?");
    expect(archiveConfirmMessage(50)).toContain("Approved words are not affected");
  });
  it("the manager has the button, asks for confirmation first, and refreshes the counts afterwards", () => {
    const src = readFileSync(new URL("../../components/wordbank/WordBankManager.tsx", import.meta.url), "utf8");
    expect(src).toContain("Archive Selected Drafts (");
    expect(src).toContain("Select all {Math.min(drafts.length, 200)} drafts shown");
    const fn = src.slice(src.indexOf("const archiveSelected"), src.indexOf("const saveEdit"));
    expect(fn.indexOf("window.confirm(archiveConfirmMessage(n))")).toBeGreaterThan(-1);
    expect(fn.indexOf("window.confirm")).toBeLessThan(fn.indexOf("api.archiveDrafts"));
    expect(fn).toContain("await load()");
    expect(fn).toContain("setSelected(new Set())");
  });
  it("draft cards (and only draft cards) carry the selection checkbox", () => {
    const src = readFileSync(new URL("../../components/wordbank/WordCard.tsx", import.meta.url), "utf8");
    expect(src).toContain('w.status === "draft" ? (');
    expect(src).toContain('type="checkbox"');
  });
});

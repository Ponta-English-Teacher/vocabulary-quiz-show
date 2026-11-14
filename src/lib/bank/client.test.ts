import { describe, expect, it, vi } from "vitest";
import { makeApi } from "./client";

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("word bank client (mock fetch)", () => {
  it("sends the teacher header, the right method and path, and never puts secrets in the URL", async () => {
    const f = vi.fn(async () => reply({ ok: true, words: [], counts: { draft: 0, approved: 0, archived: 0, total: 0 }, unreadable: 0 }));
    const api = makeApi({ fetchImpl: f as unknown as typeof fetch, headers: () => ({ "x-teacher-passcode": "pw-123" }) });
    await api.list({ status: "draft" });
    await api.approve("b1");
    await api.edit("b1", { category: "x" });
    await api.archive("b1");
    await api.restore("b1");
    await api.approveMany(["a", "b"]);
    await api.create({ word: "x" });
    await api.importDrafts("[]", "a.json", [2]);
    await api.preview("[]", "a.json");
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      "GET /api/wordbank?status=draft", "POST /api/wordbank/b1/approve", "PATCH /api/wordbank/b1", "POST /api/wordbank/b1/archive", "POST /api/wordbank/b1/restore",
      "POST /api/wordbank/approve-many", "POST /api/wordbank", "POST /api/wordbank/import", "POST /api/wordbank/import",
    ]);
    for (const [u, i] of calls) { expect((i.headers as Record<string, string>)["x-teacher-passcode"]).toBe("pw-123"); expect(u).not.toContain("pw-123"); expect(String(i.body ?? "")).not.toContain("pw-123"); }
    expect(JSON.parse(String(calls[7][1].body))).toEqual({ text: "[]", filename: "a.json", keep: [2] });
    expect(JSON.parse(String(calls[8][1].body))).toMatchObject({ dryRun: true });
  });
  it("maps errors, including validation issues, and calls onUnauthorized on 401", async () => {
    const onUnauthorized = vi.fn();
    const api = makeApi({ onUnauthorized, fetchImpl: (async () => reply({ ok: false, error: { code: "teacher_auth", message: "That teacher passcode isn't right." } }, 401)) as unknown as typeof fetch });
    expect(await api.list()).toEqual({ ok: false, status: 401, code: "teacher_auth", message: "That teacher passcode isn't right." });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const bad = makeApi({ fetchImpl: (async () => reply({ ok: false, error: { code: "invalid", message: "Fix 1 problem", issues: [{ severity: "error", code: "leak" }] } }, 422)) as unknown as typeof fetch });
    const r = await bad.approve("b1");
    expect(r).toMatchObject({ ok: false, status: 422, code: "invalid" });
    if (!r.ok) expect(r.issues).toHaveLength(1);
  });
  it("turns network failures and unreadable replies into plain messages", async () => {
    const net = makeApi({ fetchImpl: (async () => { throw new Error("offline https://secret"); }) as unknown as typeof fetch });
    const r = await net.list();
    expect(r).toMatchObject({ ok: false, code: "network" });
    if (!r.ok) expect(r.message).not.toContain("secret");
    expect(await makeApi({ fetchImpl: (async () => reply("<html>", 502)) as unknown as typeof fetch }).list()).toMatchObject({ ok: false, code: "bad_response" });
  });
  it("export returns the text and the server's file name", async () => {
    const api = makeApi({ fetchImpl: (async () => reply('{"words":[]}', 200, { "content-disposition": 'attachment; filename="vqs-wordbank-2026-11-14.json"' })) as unknown as typeof fetch });
    expect(await api.exportAll()).toEqual({ ok: true, data: { text: '{"words":[]}', filename: "vqs-wordbank-2026-11-14.json" } });
    const denied = makeApi({ fetchImpl: (async () => reply({ ok: false, error: { message: "Teacher tools are locked." } }, 503)) as unknown as typeof fetch });
    expect(await denied.exportAll()).toMatchObject({ ok: false, status: 503, message: "Teacher tools are locked." });
  });
});

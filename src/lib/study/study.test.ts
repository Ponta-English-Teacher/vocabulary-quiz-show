import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { StudyList } from "@/components/study/StudyList";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { selectWords } from "@/lib/playCount";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import * as listRoute from "../../app/api/study/route";
import * as tokenRoute from "../../app/api/study/[token]/route";
import { StudyService, STUDY_TTL } from "./service";

const word = (n: string, over: Partial<VocabWord> = {}): VocabWord => ({
  id: `id-${n}`, word: n, accept: [`${n}s`], partOfSpeech: "noun", category: "Kitchen", cefr: "A2",
  meaning: `the meaning of ${n} in simple English`, example: `We used the ${n} yesterday.`,
  hints: [`PRIVATE-HINT-1-${n}`, `PRIVATE-HINT-2-${n}`, `PRIVATE-HINT-3-${n}`],
  ja: [`日本語-${n}`], giverInfo: { looks: `PRIVATE-LOOKS-${n}`, use: `PRIVATE-USE-${n}`, phrases: [`PRIVATE-PHRASE-${n}`] },
  illustration: { src: "", alt: "PRIVATE-PICTURE" }, ...over,
});
const LIST_A = ["colander", "whisk", "ladle"].map((n) => word(n));
const LIST_B = ["towel", "drawer"].map((n) => word(n));

class SpyKV extends MemoryKV {
  writes: { key: string; value: string }[] = [];
  async set(key: string, value: string, ttl: number) { this.writes.push({ key, value }); return super.set(key, value, ttl); }
}

describe("publishing a study page", () => {
  it("stores and returns ONLY study fields — never hints, Giver notes, pictures or accepted answers", async () => {
    const kv = new SpyKV();
    const svc = new StudyService(kv);
    const p = await svc.publish({ title: "Kitchen words", words: LIST_A });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const g = await svc.get(p.token);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.view.title).toBe("Kitchen words");
    expect(g.view.words.map((w) => w.word)).toEqual(["colander", "whisk", "ladle"]);
    expect(g.view.words[0]).toEqual({ word: "colander", partOfSpeech: "noun", meaning: "the meaning of colander in simple English", ja: ["日本語-colander"], example: "We used the colander yesterday." });
    const everything = JSON.stringify(g) + kv.writes.map((w) => w.value).join("");
    expect(everything).not.toMatch(/PRIVATE|hints|giverInfo|illustration|accept|categor|cefr/i);
    // the store is keyed by a hash of the token, so reading storage never reveals a link
    expect(kv.writes.every((w) => !w.key.includes(p.token))).toBe(true);
  });
  it("a word without Japanese is still shown (empty Japanese list), and 1 to 10 word lists both work", async () => {
    const svc = new StudyService(new MemoryKV());
    const one = await svc.publish({ title: "One", words: [word("towel", { ja: undefined })] });
    const ten = await svc.publish({ title: "Ten", words: SAMPLE_SET.words });
    expect(one.ok && ten.ok).toBe(true);
    if (!one.ok || !ten.ok) return;
    const a = await svc.get(one.token);
    expect(a.ok && a.view.words[0]).toMatchObject({ ja: [] });
    const b = await svc.get(ten.token);
    expect(b.ok && b.view.words.map((w) => w.word)).toEqual(SAMPLE_SET.words.map((w) => w.word));
    expect(b.ok && b.view.words.length).toBe(10);
  });
  it("rejects empty or malformed requests", async () => {
    const svc = new StudyService(new MemoryKV());
    for (const bad of [{ title: "", words: LIST_A }, { title: "x", words: [] }, { title: "x", words: "nope" }, { title: "x", words: [{ word: 5 }] }, { title: 3, words: LIST_A }]) {
      expect((await svc.publish(bad as never)).ok).toBe(false);
    }
  });
});

describe("study links are unguessable, separate and read-only", () => {
  it("each page has its own long random token; one token never opens another page", async () => {
    const svc = new StudyService(new MemoryKV());
    const a = await svc.publish({ title: "A", words: LIST_A });
    const b = await svc.publish({ title: "B", words: LIST_B });
    if (!a.ok || !b.ok) throw new Error("publish failed");
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits
    expect(a.token).not.toBe(b.token);
    const ga = await svc.get(a.token);
    const gb = await svc.get(b.token);
    expect(ga.ok && ga.view.words.map((w) => w.word)).toEqual(["colander", "whisk", "ladle"]);
    expect(gb.ok && gb.view.words.map((w) => w.word)).toEqual(["towel", "drawer"]);
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) { const r = await svc.publish({ title: "t", words: LIST_B }); if (r.ok) tokens.add(r.token); }
    expect(tokens.size).toBe(200);
  });
  it("guesses, malformed tokens, class ids and empty strings all get the same plain 'not available'", async () => {
    const svc = new StudyService(new MemoryKV());
    await svc.publish({ title: "A", words: LIST_A });
    for (const t of ["", "x", "a1b2c3d4e5", "AAAAAAAAAAAAAAAAAAAAAA", "../../etc/passwd", "a".repeat(200)]) {
      const r = await svc.get(t);
      expect(r).toMatchObject({ ok: false, code: "not_found" });
    }
  });
  it("there is no way to list pages: the service and the routes expose publish / read-one / take-down only", () => {
    expect(Object.getOwnPropertyNames(StudyService.prototype).filter((n) => !["constructor", "kv", "guard"].includes(n)).sort()).toEqual(["get", "publish", "unshare"]);
    expect(Object.keys(listRoute).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"]);
    expect(Object.keys(tokenRoute).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["DELETE", "GET"]);
  });
  it("a published page is a snapshot: re-publishing changed words does not alter the old page", async () => {
    const svc = new StudyService(new MemoryKV());
    const first = await svc.publish({ title: "L", words: LIST_A });
    const second = await svc.publish({ title: "L", words: [LIST_A[0]] });
    if (!first.ok || !second.ok) throw new Error();
    const g = await svc.get(first.token);
    expect(g.ok && g.view.words).toHaveLength(3);
  });
});

describe("expiry and taking a page down", () => {
  it("a page expires by itself after the time limit", async () => {
    let t = 1_000_000;
    const kv = new MemoryKV(() => t);
    const svc = new StudyService(kv, () => t);
    const p = await svc.publish({ title: "A", words: LIST_A });
    if (!p.ok) throw new Error();
    expect(p.expiresAt).toBe(t + STUDY_TTL * 1000);
    t += (STUDY_TTL - 5) * 1000;
    expect((await svc.get(p.token)).ok).toBe(true);
    t += 10 * 1000;
    expect(await svc.get(p.token)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("the teacher can unshare one page without touching the others; unsharing twice is harmless", async () => {
    let t = 5_000_000;
    const kv = new MemoryKV(() => t);
    const svc = new StudyService(kv, () => t);
    const a = await svc.publish({ title: "A", words: LIST_A });
    const b = await svc.publish({ title: "B", words: LIST_B });
    if (!a.ok || !b.ok) throw new Error();
    expect((await svc.unshare(a.token)).ok).toBe(true);
    t += 2000; // the take-down marker is a 1-second entry that never parses as a page
    expect(await svc.get(a.token)).toMatchObject({ ok: false, code: "not_found" });
    expect((await svc.get(b.token)).ok).toBe(true);
    expect((await svc.unshare(a.token)).ok).toBe(true);
    expect((await svc.unshare("not-a-token")).ok).toBe(true);
  });
  it("even before the marker expires, a taken-down page is gone", async () => {
    const svc = new StudyService(new MemoryKV());
    const a = await svc.publish({ title: "A", words: LIST_A });
    if (!a.ok) throw new Error();
    await svc.unshare(a.token);
    expect(await svc.get(a.token)).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("routes: students need no login, teachers do", () => {
  afterEach(() => vi.unstubAllEnvs());
  const post = (headers: Record<string, string> = {}, body: unknown = { title: "Route list", words: LIST_A }) =>
    listRoute.POST(new Request("http://localhost/api/study", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  it("publishing and taking down require the teacher passcode; reading does not", async () => {
    vi.stubEnv("TEACHER_PASSCODE", "secret-passcode");
    expect((await post()).status).toBe(401);
    const ok = await post({ "x-teacher-passcode": "secret-passcode" });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.path).toBe(`/study/${j.token}`);
    // a student: no header, no cookie, no account
    const read = await tokenRoute.GET(new Request(`http://localhost/api/study/${j.token}`), { params: Promise.resolve({ token: j.token }) });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(read.headers.get("x-robots-tag")).toMatch(/noindex/);
    const body = await read.json();
    expect(body.words.map((w: { word: string }) => w.word)).toEqual(["colander", "whisk", "ladle"]);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|hints|giverInfo|accept/i);
    // a student cannot take it down
    const del = await tokenRoute.DELETE(new Request(`http://localhost/api/study/${j.token}`, { method: "DELETE" }), { params: Promise.resolve({ token: j.token }) });
    expect(del.status).toBe(401);
    expect((await tokenRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ token: j.token }) })).status).toBe(200);
    // the teacher can
    const del2 = await tokenRoute.DELETE(new Request(`http://localhost/api/study/${j.token}`, { method: "DELETE", headers: { "x-teacher-passcode": "secret-passcode" } }), { params: Promise.resolve({ token: j.token }) });
    expect(del2.status).toBe(200);
    expect((await tokenRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ token: j.token }) })).status).toBe(404);
  });
  it("an unknown token is a plain 404 with no detail", async () => {
    const r = await tokenRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ token: "A".repeat(22) }) });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/vqs:|kv|redis|stack/i);
  });
});

describe("the student page", () => {
  it("shows every word with definition, Japanese, example and pronunciation buttons — and nothing private", () => {
    const words = LIST_A.map((w) => ({ word: w.word, partOfSpeech: w.partOfSpeech, meaning: w.meaning, ja: w.ja ?? [], example: w.example }));
    const html = renderToStaticMarkup(h(StudyList, { title: "Kitchen words", words }));
    for (const w of LIST_A) {
      expect(html).toContain(`>${w.word}<`);
      expect(html).toContain(w.meaning);
      expect(html).toContain(`日本語-${w.word}`);
      expect(html).toContain(w.example);
      expect(html).toContain(`Hear the word ${w.word}`); // the existing speech button
    }
    expect(html).toContain("3 words");
    expect(html).not.toMatch(/PRIVATE|hint/i);
    expect(html).not.toMatch(/<input|<textarea|Lock it in|score/i); // a study resource, not a game
  });
  it("a word without Japanese shows a dash, and one word reads '1 word'", () => {
    const html = renderToStaticMarkup(h(StudyList, { title: "T", words: [{ word: "towel", partOfSpeech: "noun", meaning: "m", ja: [], example: "" }] }));
    expect(html).toContain("1 word");
    expect(html).toContain("<em>—</em>");
  });
});

describe("QR codes for study links", () => {
  it("a study link can be turned into a scannable QR code", async () => {
    const url = "https://vocabulary-quiz-show.vercel.app/study/AAAAAAAAAAAAAAAAAAAAAA";
    const png = await QRCode.toDataURL(url, { errorCorrectionLevel: "M" });
    expect(png.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("classroom consistency", () => {
  it("the study page for a class is built from exactly the words the class was created with", async () => {
    const kv = new MemoryKV();
    const cls = new ClassService(kv);
    const picked = selectWords(SAMPLE_SET.words, 5);
    const c = await cls.createActivity({ title: "Class", words: picked });
    const sp = await new StudyService(kv).publish({ title: "Class", words: picked });
    if (!c.ok || !sp.ok) throw new Error();
    const g = await new StudyService(kv).get(sp.token);
    expect(g.ok && g.view.words.map((w) => w.word)).toEqual(c.activity.words.map((w) => w.word));
    expect(c.activity.words).toHaveLength(5);
  });
});

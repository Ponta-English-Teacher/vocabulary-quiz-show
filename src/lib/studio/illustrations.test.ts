import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { ClassService, MAX_DRAWS_PER_ACTIVITY, MAX_DRAWS_PER_WORD, type Drawer } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { redactForTaker, gameReducer as reduce, createInitialState as initialState } from "@/lib/game";
import { parseAction } from "@/lib/class/engine";
import { giverPointsFor, takerPointsFor } from "@/lib/scoring";
import { approveSet, createActivity, createSet, setIllustration, todaysWords, updateWord } from "./ops";
import { generateIllustration, illustrationPrompt, IllustrateError } from "./illustration";
import { loadActivities, saveActivity, type StorageLike } from "./storage";
import { coerceIllustration, coerceWord, LIMITS } from "./validation";
import type { Activity } from "./types";

const pic = (tag: string) => `data:image/jpeg;base64,${Buffer.from(`JPEGDATA-${tag}-`.repeat(8)).toString("base64")}`;
const mem = (): StorageLike => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};
const words = (withPics: boolean): VocabWord[] =>
  SAMPLE_SET.words.map((w, i) => ({
    ...w, id: `p${i}`, word: `zorb${w.word}`, accept: [], hints: w.hints.map((h) => h.replaceAll(w.word, "it")),
    ...(withPics ? { illustration: { src: pic(`W${i}`), alt: `alt ${i}` } } : {}),
  }));
const approved = (withPics: boolean): Activity => {
  const a = { ...createActivity("Pics", "2026-04-01T00:00:00Z"), sets: [createSet(words(withPics), "Set 1")] };
  const r = approveSet(a, a.sets[0].id);
  if (r.problems.length) throw new Error(r.problems.join("; "));
  return r.activity;
};

describe("illustration data", () => {
  it("accepts inline jpeg/png/webp pictures only", () => {
    expect(coerceIllustration({ src: pic("a"), alt: " a cat " })).toEqual({ src: pic("a"), alt: "a cat" });
    for (const bad of ["https://example.com/x.jpg", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,AAAA", "javascript:alert(1)", "", 5, null]) {
      expect(coerceIllustration({ src: bad })).toBeUndefined();
    }
    expect(coerceIllustration({ src: "data:image/jpeg;base64," + "A".repeat(LIMITS.illustrationSrc) })).toBeUndefined();
    expect(coerceIllustration({ src: "" })).toBeUndefined();
    expect(coerceIllustration({ src: "" }, true)).toEqual({ src: "" });
  });
  it("words without a picture (older saved sets, the preset) are unchanged", () => {
    expect(SAMPLE_SET.words.some((w) => w.illustration)).toBe(false);
    const c = coerceWord(words(false)[0]);
    expect("word" in c && c.word.illustration).toBeUndefined();
  });
  it("a picture survives coerceWord and the browser save/load round trip", () => {
    const a = approved(true);
    const st = mem();
    expect(saveActivity(st, a).ok).toBe(true);
    const back = loadActivities(st).activities[0];
    expect(back.sets[0].words.map((w) => w.illustration?.src)).toEqual(words(true).map((w) => w.illustration!.src));
  });
});

describe("Studio operations", () => {
  it("adding or removing a picture does not un-approve the set; editing text does", () => {
    const a = approved(false);
    const s = a.sets[0];
    const withPic = setIllustration(a, s.id, s.words[0].id, { src: pic("x") });
    expect(withPic.sets[0].status).toBe("approved");
    expect(withPic.sets[0].words[0].illustration?.src).toBe(pic("x"));
    expect(withPic.sets[0].words[1]).toBe(s.words[1]); // other words untouched
    expect(setIllustration(withPic, s.id, s.words[0].id, undefined).sets[0].words[0].illustration).toBeUndefined();
    const edited = updateWord(withPic, s.id, s.words[0].id, { meaning: "A different meaning, written by the teacher." });
    expect(edited.sets[0].status).toBe("draft");
    expect(edited.sets[0].words[0].illustration?.src).toBe(pic("x")); // same word: keep
  });
  it("changing the target word drops the old picture", () => {
    const a = setIllustration(approved(false), "x", "y", undefined); // unknown ids: no-op
    const s = a.sets[0];
    const withPic = setIllustration(a, s.id, s.words[0].id, { src: pic("x") });
    const renamed = updateWord(withPic, s.id, s.words[0].id, { word: "completelynewword" });
    expect(renamed.sets[0].words[0].illustration).toBeUndefined();
  });
  it("approval still works with and without pictures; Today's Words keeps them", () => {
    expect(todaysWords([approved(false)])!.words.every((w) => !w.illustration)).toBe(true);
    expect(todaysWords([approved(true)])!.words.map((w) => w.illustration?.src)).toEqual(words(true).map((w) => w.illustration!.src));
  });
});

describe("drawing a picture (fake image service — no real call)", () => {
  const w = words(false)[0];
  const ok = (b64 = Buffer.from("x".repeat(64)).toString("base64")) => async () => new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
  it("sends one low-quality image request and returns a storable picture", async () => {
    let body: Record<string, unknown> = {}, auth = "";
    const r = await generateIllustration({ apiKey: "k", fetchImpl: async (_u, init) => { body = JSON.parse(String(init.body)); auth = String((init.headers as Record<string, string>).Authorization); return ok()(); } }, w);
    expect(r.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(body).toMatchObject({ n: 1, quality: "low", output_format: "jpeg" });
    expect(auth).toBe("Bearer k");
    expect(String(body.prompt)).toMatch(/no text of any kind/i);
  });
  it("fails gracefully with readable reasons (and never echoes the upstream body or key)", async () => {
    const fail = (status: number) => async () => new Response("secret upstream detail sk-123", { status });
    await expect(generateIllustration({ apiKey: "k", fetchImpl: fail(400) }, w)).rejects.toMatchObject({ code: "refused" });
    const e = (await generateIllustration({ apiKey: "k", fetchImpl: fail(500) }, w).catch((x) => x)) as IllustrateError;
    expect(e.code).toBe("upstream");
    expect(e.message).not.toContain("secret");
    await expect(generateIllustration({ apiKey: "k", fetchImpl: async () => { throw new Error("net"); } }, w)).rejects.toMatchObject({ code: "upstream" });
    await expect(generateIllustration({ apiKey: "k", fetchImpl: async () => new Response("{}", { status: 200 }) }, w)).rejects.toMatchObject({ code: "malformed" });
    await expect(generateIllustration({ apiKey: "k", fetchImpl: ok("A".repeat(LIMITS.illustrationSrc)) }, w)).rejects.toMatchObject({ code: "too_large" });
  });
  it("abstract words get a scene prompt; concrete words a direct one", () => {
    expect(illustrationPrompt({ ...w, partOfSpeech: "adjective" })).toMatch(/everyday scene/);
    expect(illustrationPrompt({ ...w, partOfSpeech: "noun" })).toMatch(/Draw the meaning/);
  });
});


// ------------------------------------------------------------------------------------------------
// Illustration as a last-resort hint (classroom: server-side)
// ------------------------------------------------------------------------------------------------
const drawnPic = (id: string) => pic(`DRAWN-${id}`);
const b64 = (src: string) => src.split(",")[1];

/** A fake image service: counts calls, can fail, and can be held open to test overlapping requests. */
function fakeDrawer(opts: { fail?: boolean; gate?: Promise<void> } = {}) {
  const calls: string[] = [];
  const drawer: Drawer = async (w) => {
    calls.push(w.id);
    if (opts.gate) await opts.gate;
    if (opts.fail) throw new IllustrateError("upstream", "The picture service returned an error (HTTP 500).");
    return { src: drawnPic(w.id), alt: "x" };
  };
  return { calls, drawer };
}

async function start(o: { studioPics?: boolean; drawer?: Drawer; noDrawer?: boolean } = {}) {
  let now = 1_000_000;
  const kv = new MemoryKV(() => now);
  const svc = new ClassService(kv, () => now, {
    ...(o.noDrawer ? {} : { drawer: o.drawer ?? fakeDrawer().drawer }),
    lockWaitMs: 400,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
  });
  const set = todaysWords([approved(!!o.studioPics)])!;
  const created = await svc.createActivity({ title: set.title, words: set.words });
  if (!created.ok) throw new Error("create");
  const id = created.activity.id;
  async function pair(group: string) {
    const A = await svc.join({ activityId: id, group, name: "Aki" });
    const B = await svc.join({ activityId: id, group, name: "Ben" });
    if (!A.ok || !B.ok) throw new Error("join");
    const act = (t: string, action: object, n: string) => svc.act({ activityId: id, group, token: t, opId: `${group}-${n}`, action: action as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }, "1");
    await act(B.token, { type: "CONFIRM_ROLES" }, "2");
    await act(A.token, { type: "CONTINUE" }, "3");
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group, token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    const ask = (t: string) => svc.requestIllustration({ activityId: id, group, token: t });
    const pick = (n: number) => act(A.token, { type: "PICK", wordId: set.words[n].id }, `pick${n}`);
    const guess = (text: string, n = "g") => act(B.token, { type: "GUESS", text }, n + Math.random());
    const guessJa = (text: string) => act(B.token, { type: "GUESS_JA", text }, "j" + Math.random());
    const scores = async () => (await view(A.token)).game!.players.map((p) => p.score);
    return { A, B, act, view, ask, pick, guess, guessJa, scores, group };
  }
  return { svc, kv, id, set, pair, created };
}
const cur = (v: { game: { words: VocabWord[]; currentWordId: string | null } | null }) => v.game!.words.find((w) => w.id === v.game!.currentWordId)!;
const PIC_RE = /base64/;

describe("illustration is NOT automatic", () => {
  it("Studio-made pictures are not shown to the Giver at the start of a round (or to anyone), and no image is requested", async () => {
    const f = fakeDrawer();
    const e = await start({ studioPics: true, drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(3);
    for (let i = 0; i < 3; i++) {
      const g = await p.view(p.A.token), t = await p.view(p.B.token);
      expect(JSON.stringify(g)).not.toMatch(PIC_RE);
      expect(JSON.stringify(t)).not.toMatch(PIC_RE);
      expect(cur(g).illustration).toBeUndefined();
      expect(g.game!.illustrationUsed).toBeFalsy();
    }
    await e.svc.join({ activityId: e.id, group: "1", name: "Aki", token: p.A.token }); // reconnect
    expect(f.calls).toHaveLength(0);
  });
  it("hosting, picking, hints, polling and answering never trigger a paid image call", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(0);
    await p.act(p.A.token, { type: "REVEAL_HINT" }, "h");
    for (let i = 0; i < 5; i++) await p.view(p.B.token);
    await p.guess("wrong");
    await p.guess(e.set.words[0].word);
    expect(f.calls).toHaveLength(0);
  });
  it("a phone cannot apply the illustration penalty itself (it is not a client action)", async () => {
    const e = await start();
    const p = await e.pair("1");
    await p.pick(0);
    expect(parseAction({ type: "ILLUSTRATION_USED" })).toBeNull();
    const r = await p.act(p.A.token, { type: "ILLUSTRATION_USED" }, "x");
    expect(r.ok).toBe(false);
    expect((await p.view(p.A.token)).game!.illustrationUsed).toBeFalsy();
  });
});

describe("requesting an illustration: who, and what the server decides", () => {
  it("only the active Giver; the Taker, a stranger and a premature request are refused without any AI call", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    const early = await p.ask(p.A.token);
    expect(early).toMatchObject({ ok: false, code: "bad_action" }); // no word in play yet
    await p.pick(1);
    expect(await p.ask(p.B.token)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await p.ask("not-a-token")).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await e.svc.requestIllustration({ activityId: e.id, group: "99", token: p.A.token })).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
    expect(((await p.view(p.A.token)).game!.illustrationUsed)).toBeFalsy();
    expect(await p.scores()).toEqual([0, 0]);
  });
  it("the server picks the word: it draws the word in play, whatever else exists", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(6);
    expect((await p.ask(p.A.token)).ok).toBe(true);
    expect(f.calls).toEqual([e.set.words[6].id]);
  });
  it("after the round ends nobody can ask for (or be charged for) an illustration", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(0);
    await p.act(p.A.token, { type: "SKIP" }, "s");
    expect(await p.ask(p.A.token)).toMatchObject({ ok: false, code: "bad_action" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("successful illustration: the Giver sees it, the score is capped, the Taker never gets it", () => {
  it("draws once, caches, shows the Giver only, and caps the word at 25 (English)", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(2);
    const r = await p.ask(p.A.token);
    if (!r.ok) throw new Error(r.message);
    expect(r.applied).toBe(true);
    expect(cur(r.view!).illustration?.src).toBe(drawnPic(e.set.words[2].id));
    expect(r.view!.game!.illustrationUsed).toBe(true);
    expect(await e.kv.get(`vqs:img:${e.id}:${e.set.words[2].id}`)).toBe(drawnPic(e.set.words[2].id));
    const t = await p.view(p.B.token);
    const tj = JSON.stringify(t);
    expect(tj).not.toMatch(PIC_RE);
    expect(tj).not.toContain(b64(drawnPic(e.set.words[2].id)));
    expect(cur(t).illustration).toBeUndefined();
    expect(t.game!.illustrationUsed).toBe(true); // the Taker only learns the word is now worth less
    await p.guess(e.set.words[2].word);
    expect(await p.scores()).toEqual([13, 25]); // Giver: half of 25, rounded up
  });
  it("is capped at 25 even when no text hint was used, and also after text hints", async () => {
    const e = await start();
    const p = await e.pair("1");
    await p.pick(0);
    await p.act(p.A.token, { type: "REVEAL_HINT" }, "h1");
    await p.ask(p.A.token);
    await p.guess(e.set.words[0].word);
    expect(await p.scores()).toEqual([13, 25]);
  });
  it("Japanese answer after an illustration earns 13 (Giver 7)", async () => {
    const e = await start();
    const p = await e.pair("1");
    await p.pick(0);
    await p.ask(p.A.token);
    const ja = e.set.words[0].ja![0];
    const r = await p.guessJa(ja);
    expect(r.ok && r.applied).toBe(true);
    expect(await p.scores()).toEqual([7, 13]);
  });
  it("scoring arithmetic: 25/13 for every hint count; Giver gets half, rounded up", () => {
    for (let n = 0; n <= 6; n++) {
      expect(takerPointsFor(n, "en", true)).toBe(25);
      expect(takerPointsFor(n, "ja", true)).toBe(13);
    }
    expect(giverPointsFor(25)).toBe(13);
    expect(giverPointsFor(13)).toBe(7);
    expect(takerPointsFor(0, "en", false)).toBe(100); // unchanged without an illustration
    expect(takerPointsFor(1, "ja", false)).toBe(43);
  });
  it("the cap cannot be avoided by refreshing, reconnecting or asking again (and is never charged twice)", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(0);
    await p.ask(p.A.token);
    const again = await p.ask(p.A.token);
    expect(again.ok && again.applied).toBe(false);
    expect(f.calls).toHaveLength(1);
    const rejoin = await e.svc.join({ activityId: e.id, group: "1", name: "Aki", token: p.A.token });
    if (!rejoin.ok) throw new Error("rejoin");
    expect(rejoin.view.game!.illustrationUsed).toBe(true);
    expect(cur(rejoin.view).illustration?.src).toBe(drawnPic(e.set.words[0].id)); // still there after reconnecting, same round
    const tRejoin = await e.svc.join({ activityId: e.id, group: "1", name: "Ben", token: p.B.token });
    if (!tRejoin.ok) throw new Error("rejoin");
    expect(JSON.stringify(tRejoin.view)).not.toMatch(PIC_RE);
    await p.guess(e.set.words[0].word);
    expect(await p.scores()).toEqual([13, 25]);
  });
  it("the cap is for that round only: the next word is worth full points again", async () => {
    const e = await start();
    const p = await e.pair("1");
    await p.pick(0);
    await p.ask(p.A.token);
    await p.act(p.A.token, { type: "SKIP" }, "s");
    await p.act(p.A.token, { type: "NEXT" }, "n");
    await p.act(p.B.token, { type: "CONTINUE" }, "c"); // roles swap: Ben is the Giver now
    const gBen = await p.act(p.B.token, { type: "PICK", wordId: e.set.words[1].id }, "p2");
    expect(gBen.ok).toBe(true);
    const v = await p.view(p.B.token);
    expect(v.game!.illustrationUsed).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(PIC_RE);
    await p.act(p.A.token, { type: "GUESS", text: e.set.words[1].word }, "g");
    expect((await p.scores())[0]).toBe(100); // Aki, the Taker now, earns the full 100
  });
});

describe("failed illustration: no penalty, the game continues", () => {
  it("reports the failure, deducts nothing, stays playable, and allows a later retry", async () => {
    const bad = fakeDrawer({ fail: true });
    const e = await start({ drawer: bad.drawer });
    const p = await e.pair("1");
    await p.pick(0);
    const r = await p.ask(p.A.token);
    expect(r).toMatchObject({ ok: false, code: "picture_failed" });
    expect(r.ok ? "" : r.message).toMatch(/score is unchanged/i);
    expect(r.ok ? "" : r.message).not.toMatch(/HTTP|sk-/); // no upstream details
    const v = await p.view(p.A.token);
    expect(v.game!.illustrationUsed).toBeFalsy();
    expect(cur(v).illustration).toBeUndefined();
    await p.guess(e.set.words[0].word);
    expect(await p.scores()).toEqual([50, 100]); // full points
  });
  it("a failed drawing releases the lock so the next request can draw", async () => {
    let fail = true;
    const calls: string[] = [];
    const drawer: Drawer = async (w) => { calls.push(w.id); if (fail) throw new IllustrateError("timeout", "The picture took too long to draw. Try again."); return { src: drawnPic(w.id) }; };
    const e = await start({ drawer });
    const p = await e.pair("1");
    await p.pick(0);
    expect((await p.ask(p.A.token)).ok).toBe(false);
    fail = false;
    const r = await p.ask(p.A.token);
    expect(r.ok && r.applied).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it("with no image service configured the request fails politely and costs nothing", async () => {
    const e = await start({ noDrawer: true });
    const p = await e.pair("1");
    await p.pick(0);
    expect(await p.ask(p.A.token)).toMatchObject({ ok: false, code: "picture_failed" });
    await p.guess(e.set.words[0].word);
    expect(await p.scores()).toEqual([50, 100]);
  });
  it("if the round ends while the picture is being drawn, the Taker's full score stands and the Giver is not charged", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeDrawer({ gate });
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(0);
    const pending = p.ask(p.A.token);
    await new Promise((r) => setTimeout(r, 20));
    await p.guess(e.set.words[0].word); // the Taker answers while it is drawing
    release();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: "bad_action" });
    expect(await p.scores()).toEqual([50, 100]);
  });
});

describe("caching and no duplicate paid images", () => {
  it("reuses a picture made in Studio: no AI call, the cap applies, the Giver sees that exact picture", async () => {
    const f = fakeDrawer();
    const e = await start({ studioPics: true, drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(3);
    const r = await p.ask(p.A.token);
    if (!r.ok) throw new Error(r.message);
    expect(cur(r.view!).illustration?.src).toBe(pic("W3"));
    expect(f.calls).toHaveLength(0);
    expect(r.view!.game!.illustrationUsed).toBe(true);
  });
  it("two groups in one activity asking for the same word cost one image", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p1 = await e.pair("1"), p2 = await e.pair("2");
    await p1.pick(4); await p2.pick(4);
    expect((await p1.ask(p1.A.token)).ok).toBe(true);
    expect((await p2.ask(p2.A.token)).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    await p2.guess(e.set.words[4].word);
    expect(await p2.scores()).toEqual([13, 25]);
  });
  it("simultaneous requests for the same word draw exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeDrawer({ gate });
    const e = await start({ drawer: f.drawer });
    const p1 = await e.pair("1"), p2 = await e.pair("2");
    await p1.pick(5); await p2.pick(5);
    const a = p1.ask(p1.A.token), a2 = p1.ask(p1.A.token), b = p2.ask(p2.A.token);
    await new Promise((r) => setTimeout(r, 30));
    release();
    const rs = await Promise.all([a, a2, b]);
    expect(rs.map((r) => (r.ok ? "ok" : r.code + ":" + r.message))).toEqual(["ok", "ok", "ok"]);
    expect(f.calls).toHaveLength(1);
    expect(await p1.scores()).toEqual([0, 0]);
    await p1.guess(e.set.words[5].word);
    expect(await p1.scores()).toEqual([13, 25]); // charged once
  });
  it("a request that waits too long for someone else's drawing gives up without charging", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeDrawer({ gate });
    const e = await start({ drawer: f.drawer });
    const p1 = await e.pair("1"), p2 = await e.pair("2");
    await p1.pick(5); await p2.pick(5);
    const first = p1.ask(p1.A.token);
    await new Promise((r) => setTimeout(r, 20));
    const second = await p2.ask(p2.A.token); // lock wait is 400 ms in this test
    expect(second).toMatchObject({ ok: false, code: "busy" });
    expect(((await p2.view(p2.A.token)).game!.illustrationUsed)).toBeFalsy();
    release();
    await first;
    const retry = await p2.ask(p2.A.token); // now cached
    expect(retry.ok && retry.applied).toBe(true);
    expect(f.calls).toHaveLength(1);
  });
});

describe("cost guard (abuse protection)", () => {
  it("failed drawings are capped per word: after the limit no further paid call is made", async () => {
    const calls: string[] = [];
    const drawer: Drawer = async (w) => { calls.push(w.id); throw new IllustrateError("timeout", "slow"); };
    const e = await start({ drawer });
    const p = await e.pair("1");
    await p.pick(0);
    for (let i = 0; i < MAX_DRAWS_PER_WORD + 4; i++) await p.ask(p.A.token);
    expect(calls).toHaveLength(MAX_DRAWS_PER_WORD);
    const last = await p.ask(p.A.token);
    expect(last).toMatchObject({ ok: false, code: "picture_failed" });
    expect(last.ok ? "" : last.message).toMatch(/score is unchanged/i);
    expect(await p.scores()).toEqual([0, 0]);
    await p.guess(e.set.words[0].word);
    expect(await p.scores()).toEqual([50, 100]); // still fully playable, full points
  });
  it("a success is cached and uses one attempt; asking again (or from another group) never draws again", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p1 = await e.pair("1"), p2 = await e.pair("2");
    await p1.pick(0); await p2.pick(0);
    for (let i = 0; i < 5; i++) await p1.ask(p1.A.token);
    await p2.ask(p2.A.token);
    expect(f.calls).toHaveLength(1);
  });
  it("there is also an overall limit per hosted activity", async () => {
    const f = fakeDrawer();
    const e = await start({ drawer: f.drawer });
    const p = await e.pair("1");
    await p.pick(0);
    for (let i = 0; i < MAX_DRAWS_PER_ACTIVITY; i++) await e.kv.incr(`vqs:imgtries:${e.id}`, 60); // the activity has used up its budget
    const r = await p.ask(p.A.token);
    expect(r).toMatchObject({ ok: false, code: "picture_failed" });
    expect(f.calls).toHaveLength(0);
    expect(await p.scores()).toEqual([0, 0]);
  });
});

describe("compatibility", () => {
  it("Preset Vocabulary (no pictures) works: the picture is drawn on demand only", async () => {
    const f = fakeDrawer();
    let now = 1;
    const svc = new ClassService(new MemoryKV(() => now), () => now, { drawer: f.drawer });
    const c = await svc.createActivity({ title: SAMPLE_SET.title, words: SAMPLE_SET.words });
    if (!c.ok) throw new Error("c");
    const A = await svc.join({ activityId: c.activity.id, group: "1", name: "A" });
    const B = await svc.join({ activityId: c.activity.id, group: "1", name: "B" });
    if (!A.ok || !B.ok) throw new Error("j");
    const act = (t: string, action: object, n: string) => svc.act({ activityId: c.activity.id, group: "1", token: t, opId: n, action: action as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }, "1"); await act(B.token, { type: "CONFIRM_ROLES" }, "2"); await act(A.token, { type: "CONTINUE" }, "3");
    await act(A.token, { type: "PICK", wordId: SAMPLE_SET.words[0].id }, "4");
    expect(f.calls).toHaveLength(0);
    const r = await svc.requestIllustration({ activityId: c.activity.id, group: "1", token: A.token });
    expect(r.ok && r.applied).toBe(true);
    expect(f.calls).toEqual([SAMPLE_SET.words[0].id]);
  });
});

describe("demo mode (one local screen)", () => {
  const demo = (withPics: boolean) => {
    let s = reduce(initialState(), { type: "START", names: ["A", "B"], words: words(withPics) });
    s = reduce(s, { type: "CONTINUE" });
    return reduce(s, { type: "PICK", wordId: "p2" });
  };
  it("starts without the illustration; a Studio picture is not shown until requested", () => {
    const s = demo(true);
    expect(s.illustrationUsed).toBe(false);
  });
  it("requesting applies the cap (25 / 13) and can attach a freshly drawn picture; asking twice changes nothing", () => {
    let s = demo(false);
    s = reduce(s, { type: "ILLUSTRATION_USED", illustration: { src: pic("demo") } });
    expect(s.illustrationUsed).toBe(true);
    expect(s.words.find((w) => w.id === "p2")!.illustration?.src).toBe(pic("demo"));
    expect(reduce(s, { type: "ILLUSTRATION_USED", illustration: { src: pic("other") } })).toBe(s);
    const solved = reduce(s, { type: "GUESS", text: "zorb" + SAMPLE_SET.words[2].word });
    expect(solved.lastResult).toMatchObject({ outcome: "solved", takerPoints: 25, giverPoints: 13, illustration: true });
  });
  it("Japanese in demo after an illustration: 13", () => {
    let s = reduce(demo(false), { type: "ILLUSTRATION_USED" });
    s = reduce(s, { type: "GUESS_JA", text: SAMPLE_SET.words[2].ja![0] });
    expect(s.lastResult).toMatchObject({ takerPoints: 13, giverPoints: 7, answeredIn: "ja" });
  });
  it("is only possible while a word is in play, and the Taker's demo screen never carries the picture", () => {
    const board = reduce(reduce(reduce(initialState(), { type: "START", names: ["A", "B"], words: words(false) }), { type: "CONTINUE" }), { type: "CONTINUE" });
    expect(reduce(board, { type: "ILLUSTRATION_USED" })).toBe(board);
    const s = reduce(demo(false), { type: "ILLUSTRATION_USED", illustration: { src: pic("demo") } });
    expect(JSON.stringify(redactForTaker(s))).not.toContain("base64");
  });
});

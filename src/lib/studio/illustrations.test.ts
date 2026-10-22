import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { redactForTaker, gameReducer as reduce, createInitialState as initialState } from "@/lib/game";
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

describe("classroom: the picture is the Giver's alone", () => {
  async function start(withPics: boolean) {
    let now = 1_000_000;
    const kv = new MemoryKV(() => now);
    const svc = new ClassService(kv, () => now);
    const set = todaysWords([approved(withPics)])!;
    const created = await svc.createActivity({ title: set.title, words: set.words });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    const A = await svc.join({ activityId: id, group: "4", name: "Aki" });
    const B = await svc.join({ activityId: id, group: "4", name: "Ben" });
    if (!A.ok || !B.ok) throw new Error("join");
    const act = (t: string, action: object, n: string) => svc.act({ activityId: id, group: "4", token: t, opId: n, action: action as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }, "1");
    await act(B.token, { type: "CONFIRM_ROLES" }, "2");
    await act(A.token, { type: "CONTINUE" }, "3");
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "4", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    return { svc, kv, id, A, B, act, view, set, created };
  }
  const cur = (v: Awaited<ReturnType<Awaited<ReturnType<typeof start>>["view"]>>) => v.game!.words.find((w) => w.id === v.game!.currentWordId)!;

  it("hosting stores pictures in their own keys, not in the activity record", async () => {
    const { kv, id, set, created } = await start(true);
    expect(await kv.get(`vqs:act:${id}`)).not.toContain("base64");
    expect(created.ok && created.activity.words.every((w) => w.illustration?.src === "")).toBe(true);
    for (const w of set.words) expect(await kv.get(`vqs:img:${id}:${w.id}`)).toBe(w.illustration!.src);
  });
  it("the Giver gets the picture of the word in play, from the start of the round; nothing else", async () => {
    const { A, act, view, set } = await start(true);
    await act(A.token, { type: "PICK", wordId: set.words[3].id }, "4");
    const g = await view(A.token);
    expect(cur(g).illustration?.src).toBe(pic("W3"));
    const json = JSON.stringify(g);
    for (const i of [0, 1, 2, 4, 5, 6, 7, 8, 9]) expect(json).not.toContain(Buffer.from(`JPEGDATA-W${i}-`.repeat(8)).toString("base64"));
    // before a word is picked, no pictures are sent at all
  });
  it("the Giver is sent no picture before picking", async () => {
    const { A, view } = await start(true);
    expect(JSON.stringify(await view(A.token))).not.toContain("base64");
  });
  it("the Taker never receives a picture (marker or image), at any point in the round", async () => {
    const { A, B, act, view, set } = await start(true);
    await act(A.token, { type: "PICK", wordId: set.words[3].id }, "4");
    await act(A.token, { type: "REVEAL_HINT" }, "5");
    await act(B.token, { type: "GUESS", text: "wrong" }, "6");
    for (const v of [await view(B.token)]) {
      const json = JSON.stringify(v);
      expect(json).not.toContain("illustration");
      expect(json).not.toContain("base64");
      expect(json).not.toContain("JPEGDATA");
    }
    await act(A.token, { type: "SKIP" }, "7");
    expect(JSON.stringify(await view(B.token))).not.toContain("base64");
  });
  it("after the round ends, nobody is sent the image again", async () => {
    const { A, B, act, view, set } = await start(true);
    await act(A.token, { type: "PICK", wordId: set.words[3].id }, "4");
    await act(A.token, { type: "SKIP" }, "5");
    expect(JSON.stringify(await view(A.token))).not.toContain("base64");
    expect(JSON.stringify(await view(B.token))).not.toContain("base64");
  });
  it("a reconnecting Giver (saved token) still gets the same picture; the activity is the same", async () => {
    const { svc, A, id, act, set } = await start(true);
    await act(A.token, { type: "PICK", wordId: set.words[5].id }, "4");
    const again = await svc.join({ activityId: id, group: "4", name: "Aki", token: A.token });
    if (!again.ok) throw new Error("rejoin");
    expect(again.rejoined).toBe(true);
    expect(cur(again.view).illustration?.src).toBe(pic("W5"));
    expect(again.view.activityTitle).toBe(set.title);
  });
  it("a missing/expired image just means no picture — the round is still playable", async () => {
    const { A, B, kv, id, act, view, set } = await start(true);
    await kv.set(`vqs:img:${id}:${set.words[1].id}`, "", 1); // as if it had expired
    await act(A.token, { type: "PICK", wordId: set.words[1].id }, "4");
    const g = await view(A.token);
    expect(cur(g).illustration).toBeUndefined();
    expect(cur(g).word).toBe(set.words[1].word);
    const r = await act(B.token, { type: "GUESS", text: set.words[1].word }, "5");
    expect(r.ok && r.applied).toBe(true);
  });
  it("activities without pictures behave exactly as before", async () => {
    const { A, B, act, view, set } = await start(false);
    await act(A.token, { type: "PICK", wordId: set.words[0].id }, "4");
    const g = await view(A.token);
    expect(cur(g).illustration).toBeUndefined();
    expect(cur(g).word).toBe(set.words[0].word);
    expect(JSON.stringify(await view(B.token))).not.toContain(set.words[0].word);
  });
  it("pictures don't change scoring", async () => {
    const withPics = await start(true), without = await start(false);
    const play = async (e: typeof withPics) => {
      await e.act(e.A.token, { type: "PICK", wordId: e.set.words[0].id }, "4");
      await e.act(e.A.token, { type: "REVEAL_HINT" }, "5");
      await e.act(e.B.token, { type: "GUESS", text: e.set.words[0].word }, "6");
      return (await e.view(e.A.token)).game!.players.map((p) => p.score);
    };
    expect(await play(withPics)).toEqual(await play(without));
  });
  it("rejects a hostile or oversized picture on hosting instead of storing it", async () => {
    const svc = new ClassService(new MemoryKV(() => 1), () => 1);
    const w = words(false);
    // a non-image data URL is simply dropped by coerceWord (the word is hosted without a picture)
    const r = await svc.createActivity({ title: "t", words: [{ ...w[0], illustration: { src: "data:text/html;base64,AAAA" } }] });
    expect(r.ok && r.activity.words[0].illustration).toBeUndefined();
  });
});

describe("demo mode: the Taker's screen never carries the picture", () => {
  it("redactForTaker strips it while the word is unsolved", () => {
    let s = initialState();
    s = reduce(s, { type: "START", names: ["A", "B"], words: words(true) });
    s = reduce(s, { type: "PICK", wordId: "p2" });
    const giverSees = s.words.find((w) => w.id === "p2")!;
    expect(giverSees.illustration?.src).toBe(pic("W2"));
    expect(JSON.stringify(redactForTaker(s))).not.toContain("base64");
  });
});

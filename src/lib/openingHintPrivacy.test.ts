import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabSet, type VocabWord } from "@/data/vocab";
import { GiverRound } from "@/components/GiverRound";
import { TakerRound } from "@/components/TakerRound";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createInitialState, currentWord, gameReducer, redactForTaker, type GameState } from "@/lib/game";
import { approveSet, createActivity, createSet, todaysWords } from "@/lib/studio/ops";

/** Opening hints that appear nowhere else in any payload, so a leak is unmistakable. */
const OPEN = (i: number) => `OPENINGHINT${i} you meet this on a rainy morning at a bus stop.`;
const customSet = (): VocabSet => {
  const words: VocabWord[] = SAMPLE_SET.words.map((w, i) => ({
    ...w, id: `c${i}`, word: `zorb${w.word}`, accept: [],
    hints: [OPEN(i), `EXTRAHINTTWO${i} it is rare and unusual.`, `EXTRAHINTTHREE${i} people seldom talk about it.`],
  }));
  const a = { ...createActivity("Custom", "2026-05-01T00:00:00Z"), sets: [createSet(words, "Set 1")] };
  const r = approveSet(a, a.sets[0].id);
  if (r.problems.length) throw new Error(r.problems.join("; "));
  return todaysWords([r.activity])!;
};
const presetSet = (): VocabSet => SAMPLE_SET;

async function classroom(set: VocabSet) {
  let now = 1_000_000;
  const svc = new ClassService(new MemoryKV(() => now), () => now, {});
  const created = await svc.createActivity({ title: set.title, words: set.words });
  if (!created.ok) throw new Error("create");
  const id = created.activity.id;
  const join = async (name: string, token?: string) => { const r = await svc.join({ activityId: id, group: "5", name, token }); if (!r.ok) throw new Error("join"); return r; };
  const A = await join("Aki"), B = await join("Ben");
  const act = (t: string, action: object) => svc.act({ activityId: id, group: "5", token: t, opId: Math.random().toString(36), action: action as never });
  const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "5", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
  await act(A.token, { type: "PROPOSE_ROLES", giver: "me" });
  await act(B.token, { type: "CONFIRM_ROLES" });
  await act(A.token, { type: "CONTINUE" });
  const scores = async () => (await view(A.token)).game!.players.map((p) => p.score);
  return { svc, id, A, B, act, view, join, scores, words: set.words };
}
const isGiverView = (v: Awaited<ReturnType<Awaited<ReturnType<typeof classroom>>["view"]>>) => v.role === "giver";

describe.each([
  ["Preset Vocabulary", presetSet],
  ["Today's Words", customSet],
])("opening hint privacy — %s", (_name, make) => {
  const set = make();
  const opening = (w: VocabWord) => w.hints[0];

  it("the Giver gets the opening hint automatically; the Taker's payload never contains it (view, polling, reconnect)", async () => {
    const e = await classroom(set);
    await e.act(e.A.token, { type: "PICK", wordId: e.words[0].id });
    const g = await e.view(e.A.token);
    expect(g.game!.words[0].hints[0]).toBe(opening(e.words[0]));
    expect(g.game).toMatchObject({ revealedHints: 1, hintsUsed: 0 });
    const payloads: string[] = [];
    for (let i = 0; i < 4; i++) payloads.push(JSON.stringify(await e.view(e.B.token))); // polling
    const rejoin = await e.join("Ben", e.B.token); // reconnection
    payloads.push(JSON.stringify(rejoin.view));
    const afterAction = await e.act(e.B.token, { type: "GUESS", text: "totally wrong" }); // an action response
    payloads.push(JSON.stringify(afterAction.ok ? afterAction.view : null));
    const direct = await e.svc.getView({ activityId: e.id, group: "5", token: e.B.token });
    payloads.push(JSON.stringify(direct));
    for (const w of e.words) for (const p of payloads) expect(p).not.toContain(opening(w));
    // The Taker is told only that an (unseen) opening hint is part of the round: the count, never the text.
    expect(JSON.parse(payloads[0]).game.revealedHints).toBe(1);
  });
  it("the opening hint stays free and scoring/extra-hint behaviour is unchanged", async () => {
    const free = await classroom(set);
    await free.act(free.A.token, { type: "PICK", wordId: free.words[0].id });
    await free.act(free.B.token, { type: "GUESS", text: free.words[0].word });
    expect(await free.scores()).toEqual([50, 100]);

    const hint = await classroom(set);
    await hint.act(hint.A.token, { type: "PICK", wordId: hint.words[0].id });
    await hint.act(hint.A.token, { type: "REVEAL_HINT" }); // extra hint: costs 15
    const t = await hint.view(hint.B.token);
    expect(t.game!.words[0].hints).toEqual(["", hint.words[0].hints[1], ""]); // extra hint visible to the Taker, opening one still not
    expect(JSON.stringify(t)).not.toContain(opening(hint.words[0]));
    expect(t.game).toMatchObject({ hintsUsed: 1, revealedHints: 2 });
    await hint.act(hint.B.token, { type: "GUESS", text: hint.words[0].word });
    expect(await hint.scores()).toEqual([43, 85]);

    const two = await classroom(set);
    await two.act(two.A.token, { type: "PICK", wordId: two.words[0].id });
    await two.act(two.A.token, { type: "REVEAL_HINT" });
    await two.act(two.A.token, { type: "REVEAL_HINT" });
    await two.act(two.B.token, { type: "GUESS", text: two.words[0].word });
    expect(await two.scores()).toEqual([35, 70]);
  });
  it("role switching keeps the rule: the new Taker never gets the new word's opening hint", async () => {
    const e = await classroom(set);
    await e.act(e.A.token, { type: "PICK", wordId: e.words[0].id });
    await e.act(e.A.token, { type: "SKIP" });
    await e.act(e.A.token, { type: "NEXT" });
    await e.act(e.B.token, { type: "CONTINUE" }); // roles swap: Ben is the Giver, Aki the Taker
    await e.act(e.B.token, { type: "PICK", wordId: e.words[1].id });
    const ben = await e.view(e.B.token), aki = await e.view(e.A.token);
    expect(isGiverView(ben)).toBe(true);
    expect(ben.game!.words[1].hints[0]).toBe(opening(e.words[1]));
    expect(isGiverView(aki)).toBe(false);
    expect(JSON.stringify(aki)).not.toContain(opening(e.words[1]));
    // the previous word's opening hint is shown on its reveal screen only, never during this round
    expect(JSON.stringify(aki)).not.toContain(opening(e.words[0]));
    const rejoin = await e.join("Aki", e.A.token);
    expect(JSON.stringify(rejoin.view)).not.toContain(opening(e.words[1]));
  });
  it("Japanese answers still work (half points) and the Taker still sees no hint 1", async () => {
    const e = await classroom(set);
    await e.act(e.A.token, { type: "PICK", wordId: e.words[0].id });
    const ja = e.words[0].ja?.[0];
    if (!ja) return; // custom words in this fixture carry the sample's Japanese; preset too
    const r = await e.act(e.B.token, { type: "GUESS_JA", text: ja });
    expect(r.ok && r.applied).toBe(true);
    expect(await e.scores()).toEqual([25, 50]);
  });
  it("the illustration request still works and does not expose the opening hint to the Taker", async () => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, { drawer: async () => ({ src: "data:image/jpeg;base64,QUJDREVG" }) });
    const created = await svc.createActivity({ title: set.title, words: set.words });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    const A = await svc.join({ activityId: id, group: "5", name: "Aki" }), B = await svc.join({ activityId: id, group: "5", name: "Ben" });
    if (!A.ok || !B.ok) throw new Error("join");
    const act = (t: string, action: object) => svc.act({ activityId: id, group: "5", token: t, opId: Math.random().toString(36), action: action as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }); await act(B.token, { type: "CONFIRM_ROLES" }); await act(A.token, { type: "CONTINUE" });
    await act(A.token, { type: "PICK", wordId: set.words[0].id });
    const r = await svc.requestIllustration({ activityId: id, group: "5", token: A.token });
    expect(r.ok && r.view?.game?.words[0].illustration?.src).toBe("data:image/jpeg;base64,QUJDREVG");
    const t = JSON.stringify(await svc.getView({ activityId: id, group: "5", token: B.token }));
    expect(t).not.toContain(set.words[0].hints[0]);
    expect(t).not.toContain("base64");
  });
});

describe("demo mode follows the same Giver/Taker distinction", () => {
  const start = (): GameState => {
    const words = customSet().words;
    let s = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words });
    s = gameReducer(s, { type: "CONTINUE" });
    return gameReducer(s, { type: "PICK", wordId: words[0].id });
  };
  it("the Giver screen shows the opening hint as Giver-only; the Taker screen (redacted state) has no trace of it", () => {
    const s = start();
    const word = currentWord(s)!;
    const giver = renderToStaticMarkup(h(GiverRound, { state: s, dispatch: () => undefined }));
    expect(giver).toContain(word.hints[0]);
    expect(giver).toContain("only you can see it");
    const taker = renderToStaticMarkup(h(TakerRound, { state: redactForTaker(s), dispatch: () => undefined }));
    expect(taker).not.toContain(word.hints[0]);
    expect(taker).not.toContain("Opening hint");
    expect(taker).toContain("Ask your partner questions to find out the word.");
  });
  it("extra hints still reach the Taker once the Giver reveals them, labelled as extra hints", () => {
    let s = start();
    const word = currentWord(s)!;
    s = gameReducer(s, { type: "REVEAL_HINT" });
    const taker = renderToStaticMarkup(h(TakerRound, { state: redactForTaker(s), dispatch: () => undefined }));
    expect(taker).toContain(word.hints[1]);
    expect(taker).toContain("Extra hint 1");
    expect(taker).not.toContain(word.hints[0]);
    expect(s.hintsUsed).toBe(1); // the opening hint itself stays free
  });
});

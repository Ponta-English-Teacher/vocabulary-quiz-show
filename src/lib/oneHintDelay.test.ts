import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createInitialState, gameReducer, redactForTaker, takerVisibleHints, type GameState } from "@/lib/game";

/**
 * ONE-HINT DELAY: the Giver says each new hint aloud before it appears on the Taker's screen.
 *   opening only           → Taker sees no written hint
 *   1st paid hint revealed → Taker sees the opening hint, NOT the 1st paid hint
 *   2nd paid hint revealed → Taker sees the opening hint + 1st paid hint, NOT the 2nd
 * The newest hint's text must not be in the Taker's network response at all.
 */
const H0 = (i: number) => `OPENING${i}XQ you meet this on a rainy morning at a bus stop.`;
const H1 = (i: number) => `PAIDONE${i}XQ it is rare and unusual.`;
const H2 = (i: number) => `PAIDTWO${i}XQ people seldom talk about it.`;
const words: VocabWord[] = SAMPLE_SET.words.slice(0, 3).map((w, i) => ({
  ...w, id: `d${i}`, word: `zorbword${"abc"[i]}`, accept: [], ja: ["かさ"], hints: [H0(i), H1(i), H2(i)],
}));
const hintsOf = (i: number) => words[i].hints;

async function classroom() {
  let now = 1_000_000;
  const svc = new ClassService(new MemoryKV(() => now), () => now, {});
  const created = await svc.createActivity({ title: "Delay", words });
  if (!created.ok) throw new Error("create");
  const id = created.activity.id;
  const join = async (name: string, token?: string) => { const r = await svc.join({ activityId: id, group: "7", name, token }); if (!r.ok) throw new Error("join"); return r; };
  const A = await join("Aki"), B = await join("Ben");
  const act = (t: string, action: object) => svc.act({ activityId: id, group: "7", token: t, opId: Math.random().toString(36), action: action as never });
  const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "7", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
  await act(A.token, { type: "PROPOSE_ROLES", giver: "me" });
  await act(B.token, { type: "CONFIRM_ROLES" });
  await act(A.token, { type: "CONTINUE" });
  const scores = async () => (await view(A.token)).game!.players.map((p) => p.score);
  /** Every kind of response the Taker can receive: polling, a fresh view, reconnecting with the token, and the response to an action. */
  const takerPayloads = async (): Promise<string[]> => {
    const out: string[] = [];
    out.push(JSON.stringify(await view(B.token)));
    out.push(JSON.stringify(await view(B.token))); // polling again
    out.push(JSON.stringify((await join("Ben", B.token)).view)); // reconnecting
    const noop = await act(B.token, { type: "GUESS", text: "totally wrong guess" });
    out.push(JSON.stringify(noop.ok ? noop.view : null));
    return out;
  };
  return { svc, id, A, B, act, view, join, scores, takerPayloads };
}
type Room = Awaited<ReturnType<typeof classroom>>;
const takerHints = async (e: Room, i = 0) => (await e.view(e.B.token)).game!.words[i].hints;
const giverHints = async (e: Room, i = 0) => (await e.view(e.A.token)).game!.words[i].hints;

async function expectTakerSees(e: Room, wordIndex: number, visible: number) {
  const hints = hintsOf(wordIndex);
  expect(await takerHints(e, wordIndex)).toEqual(hints.map((h, i) => (i < visible ? h : "")));
  for (const payload of await e.takerPayloads()) {
    hints.forEach((h, i) => (i < visible ? expect(payload).toContain(h) : expect(payload, `hint ${i + 1} must not be in the Taker's response`).not.toContain(h)));
    expect(payload, "the target word never reaches the Taker").not.toContain(words[wordIndex].word);
  }
}

describe("one-hint delay — classroom server", () => {
  it("opening: the Giver has the opening hint, the Taker has no written hint", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    expect((await giverHints(e))[0]).toBe(H0(0));
    await expectTakerSees(e, 0, 0);
    expect((await e.view(e.B.token)).game).toMatchObject({ revealedHints: 1, hintsUsed: 0 });
  });

  it("first paid hint: the Taker gets the opening hint but NOT the hint just revealed", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    expect((await giverHints(e)).slice(0, 2)).toEqual([H0(0), H1(0)]); // the Giver sees everything revealed so far
    await expectTakerSees(e, 0, 1);
    expect((await e.view(e.B.token)).game).toMatchObject({ revealedHints: 2, hintsUsed: 1 });
  });

  it("second paid hint: the Taker gets opening + first paid hint, NOT the newest; earlier hints stay", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    expect(await giverHints(e)).toEqual([H0(0), H1(0), H2(0)]);
    await expectTakerSees(e, 0, 2);
    expect((await e.view(e.B.token)).game).toMatchObject({ revealedHints: 3, hintsUsed: 2 });
  });

  it("with no prepared hints left, nothing more is revealed and the last hint stays hidden until the round ends", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    for (let i = 0; i < 4; i++) await e.act(e.A.token, { type: "REVEAL_HINT" });
    await expectTakerSees(e, 0, 2);
    expect((await e.view(e.B.token)).game).toMatchObject({ revealedHints: 3, hintsUsed: 2 });
  });

  it("hints of the other words are never in the Taker's response, at any stage", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    for (let step = 0; step < 3; step++) {
      for (const payload of await e.takerPayloads()) for (const i of [1, 2]) for (const h of hintsOf(i)) expect(payload).not.toContain(h);
      await e.act(e.A.token, { type: "REVEAL_HINT" });
    }
  });

  it("spoken hints (+) and Undo (−) change the count and the score, never what the Taker can read", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.A.token, { type: "ADJUST_HINTS", delta: 1 });
    await expectTakerSees(e, 0, 0);
    expect((await e.view(e.B.token)).game).toMatchObject({ revealedHints: 1, hintsUsed: 1 });
    await e.act(e.A.token, { type: "REVEAL_HINT" }); // prepared hint after a spoken one
    await expectTakerSees(e, 0, 1);
    expect((await e.view(e.B.token)).game).toMatchObject({ revealedHints: 2, hintsUsed: 2 });
    await e.act(e.A.token, { type: "ADJUST_HINTS", delta: -1 });
    await expectTakerSees(e, 0, 1);
    expect((await e.view(e.B.token)).game).toMatchObject({ hintsUsed: 1 });
    await e.act(e.A.token, { type: "ADJUST_HINTS", delta: -1 }); // cannot go below the prepared hints already revealed
    expect((await e.view(e.B.token)).game).toMatchObject({ hintsUsed: 1 });
  });

  it("round completion: the reveal screen shows every hint, then the next word starts with none", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await e.act(e.B.token, { type: "GUESS", text: words[0].word });
    const reveal = (await e.view(e.B.token)).game!;
    expect(reveal.phase).toBe("reveal");
    expect(reveal.words[0].word).toBe(words[0].word);
    expect(reveal.words[0].hints).toEqual(hintsOf(0)); // the round is over: nothing is withheld
    await e.act(e.A.token, { type: "NEXT" });
    await e.act(e.B.token, { type: "CONTINUE" }); // roles swap: Ben gives, Aki takes
    await e.act(e.B.token, { type: "PICK", wordId: words[1].id });
    const aki = JSON.stringify(await e.view(e.A.token));
    for (const h of [...hintsOf(0), ...hintsOf(1)]) expect(aki, "a new round starts with no written hints, and the old word's hints are gone").not.toContain(h);
    expect((await e.view(e.A.token)).game!.words[1].hints).toEqual(["", "", ""]);
    expect((await e.view(e.B.token)).game!.words[1].hints[0]).toBe(H0(1)); // the new Giver has the opening hint
    await e.act(e.B.token, { type: "REVEAL_HINT" });
    expect((await e.view(e.A.token)).game!.words[1].hints).toEqual([H0(1), "", ""]); // the delay applies in every round and for either role
  });

  it("a skipped word shows its hints on the reveal screen only", async () => {
    const e = await classroom();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.A.token, { type: "REVEAL_HINT" });
    await e.act(e.A.token, { type: "SKIP" });
    expect((await e.view(e.B.token)).game!.phase).toBe("reveal");
  });

  it("scoring is unchanged: 15 points per prepared hint, Giver half, Japanese half", async () => {
    const one = await classroom();
    await one.act(one.A.token, { type: "PICK", wordId: words[0].id });
    await one.act(one.A.token, { type: "REVEAL_HINT" });
    await one.act(one.B.token, { type: "GUESS", text: words[0].word });
    expect(await one.scores()).toEqual([43, 85]);

    const two = await classroom();
    await two.act(two.A.token, { type: "PICK", wordId: words[0].id });
    await two.act(two.A.token, { type: "REVEAL_HINT" });
    await two.act(two.A.token, { type: "REVEAL_HINT" });
    await two.act(two.B.token, { type: "GUESS", text: words[0].word });
    expect(await two.scores()).toEqual([35, 70]);

    const spoken = await classroom();
    await spoken.act(spoken.A.token, { type: "PICK", wordId: words[0].id });
    await spoken.act(spoken.A.token, { type: "ADJUST_HINTS", delta: 1 });
    await spoken.act(spoken.A.token, { type: "REVEAL_HINT" });
    await spoken.act(spoken.B.token, { type: "GUESS", text: words[0].word });
    expect(await spoken.scores()).toEqual([35, 70]); // a spoken hint costs the same 15 as a prepared one

    const ja = await classroom();
    await ja.act(ja.A.token, { type: "PICK", wordId: words[0].id });
    await ja.act(ja.A.token, { type: "REVEAL_HINT" });
    await ja.act(ja.B.token, { type: "GUESS_JA", text: "かさ" });
    expect(await ja.scores()).toEqual([22, 43]);
  });
});

describe("one-hint delay — the shared redaction rule (also used by demo mode)", () => {
  const stateAt = (revealed: number): GameState => {
    let s = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words });
    s = gameReducer(s, { type: "CONTINUE" });
    s = gameReducer(s, { type: "PICK", wordId: words[0].id });
    for (let i = 1; i < revealed; i++) s = gameReducer(s, { type: "REVEAL_HINT" });
    return s;
  };
  it("shows all revealed hints except the newest, for every stage", () => {
    const expected: [number, string[]][] = [
      [1, ["", "", ""]],
      [2, [H0(0), "", ""]],
      [3, [H0(0), H1(0), ""]],
    ];
    for (const [revealed, hints] of expected) {
      const s = stateAt(revealed);
      expect(s.revealedHints).toBe(revealed);
      expect(redactForTaker(s).words[0].hints).toEqual(hints);
      expect(takerVisibleHints(s)).toBe(revealed - 1);
    }
  });
  it("never exposes the word, its accepted spellings, Japanese answers or Giver notes", () => {
    for (const revealed of [1, 2, 3]) {
      const json = JSON.stringify(redactForTaker(stateAt(revealed)));
      expect(json).not.toContain(words[0].word);
      expect(json).not.toContain("かさ");
    }
  });
  it("is a pure function of the state: the same state always gives the same Taker view (so reconnecting is consistent)", () => {
    const s = stateAt(3);
    expect(JSON.stringify(redactForTaker(s))).toBe(JSON.stringify(redactForTaker({ ...s })));
  });
  it("after the round the whole word, hints included, is shown", () => {
    let s = stateAt(2);
    s = gameReducer(s, { type: "GUESS", text: words[0].word });
    expect(redactForTaker(s).words[0].hints).toEqual(hintsOf(0));
  });
});

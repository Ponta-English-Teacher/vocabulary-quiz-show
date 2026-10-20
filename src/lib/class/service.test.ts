import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { ClassService, PRESENCE_SECONDS, type PartnerState } from "./service";
import { KvError, MemoryKV, type KV, type KvOp } from "./kv";
import { normalizeGroup } from "./engine";
import type { ClassView, ClientAction } from "./types";

/** A simulated phone: it only ever holds its own token and the last view it was sent. */
class Phone {
  token = "";
  view: ClassView | null = null;
  private n = 0;
  constructor(public svc: ClassService, public activityId: string, public group: string, public name: string) {}
  async join() {
    const r = await this.svc.join({ activityId: this.activityId, group: this.group, name: this.name, token: this.token || undefined });
    if (r.ok) { this.token = r.token; this.view = r.view; }
    return r;
  }
  async poll(extra: { since?: number; partnerWas?: PartnerState } = {}) {
    const r = await this.svc.getView({ activityId: this.activityId, group: this.group, token: this.token, ...extra });
    if (r.ok && !r.unchanged) this.view = r.view;
    return r;
  }
  async act(action: ClientAction, opId = `${this.name}-${++this.n}`) {
    const r = await this.svc.act({ activityId: this.activityId, group: this.group, token: this.token, opId, action });
    if (r.ok && r.view) this.view = r.view;
    return r;
  }
}

async function setup() {
  let now = 1_000_000;
  const kv = new MemoryKV(() => now);
  const svc = new ClassService(kv, () => now);
  const created = await svc.createActivity({ title: SAMPLE_SET.title, words: SAMPLE_SET.words });
  if (!created.ok) throw new Error("setup");
  const activity = created.activity;
  const phone = (group: string, name: string, act = activity.id, s = svc) => new Phone(s, act, group, name);
  return { kv, svc, activity, phone, advance: (ms: number) => { now += ms; } , clock: () => now };
}

/** Pair two phones and start the game with `giver` as Giver. */
async function startGame(giver: "a" | "b" = "a") {
  const env = await setup();
  const a = env.phone("7", "Aki"), b = env.phone("7", "Ben");
  await a.join(); await b.join();
  const [proposer, confirmer] = giver === "a" ? [a, b] : [b, a];
  await proposer.act({ type: "PROPOSE_ROLES", giver: "me" });
  await confirmer.act({ type: "CONFIRM_ROLES" });
  await a.poll(); await b.poll();
  return { ...env, a, b, giverPhone: giver === "a" ? a : b, takerPhone: giver === "a" ? b : a };
}
const giverWordOf = (p: Phone) => p.view!.game!.words.find((w) => w.id === p.view!.game!.currentWordId)!;
const secretsOf = (w: VocabWord) => [w.word, ...(w.accept ?? []), w.meaning, w.example, ...w.hints].filter(Boolean);

describe("group numbers", () => {
  it("normalises simple numbers and rejects junk", () => {
    expect(normalizeGroup("07")).toBe("7");
    expect(normalizeGroup(" 12 ")).toBe("12");
    for (const bad of ["", "0", "abc", "1.5", "1000", "-1", null, undefined, {}]) expect(normalizeGroup(bad)).toBeNull();
  });
});

describe("pairing", () => {
  it("two players join one group: first waits, second completes the pair", async () => {
    const { phone } = await setup();
    const a = phone("7", "Aki"), b = phone("7", "Ben");
    expect((await a.join()).ok).toBe(true);
    expect(a.view).toMatchObject({ stage: "waiting", partner: null, you: { seat: 0, name: "Aki" } });
    expect((await b.join()).ok).toBe(true);
    expect(b.view).toMatchObject({ stage: "roles", you: { seat: 1 }, partner: { name: "Aki", connected: true } });
    await a.poll();
    expect(a.view).toMatchObject({ stage: "roles", partner: { name: "Ben", connected: true } });
  });
  it("rejects a third player and does not disturb the pair", async () => {
    const { phone } = await setup();
    const a = phone("7", "Aki"), b = phone("7", "Ben"), c = phone("7", "Cleo");
    await a.join(); await b.join();
    expect(await c.join()).toMatchObject({ ok: false, code: "full" });
    expect(await c.poll()).toMatchObject({ ok: false, code: "unauthorized" });
    await a.poll();
    expect(a.view?.partner?.name).toBe("Ben");
  });
  it("keeps groups 1 and 11 (and other groups) completely separate", async () => {
    const { phone, svc, activity } = await setup();
    const p1 = phone("1", "A1"), p1b = phone("1", "B1"), p11 = phone("11", "A11"), p11b = phone("11", "B11");
    await p1.join(); await p11.join(); await p1b.join(); await p11b.join();
    await p1.poll(); await p11.poll();
    expect(p1.view?.partner?.name).toBe("B1");
    expect(p11.view?.partner?.name).toBe("B11");
    expect(await svc.getView({ activityId: activity.id, group: "11", token: p1.token })).toMatchObject({ ok: false, code: "unauthorized" });
    await p1.act({ type: "PROPOSE_ROLES", giver: "me" }); await p1b.act({ type: "CONFIRM_ROLES" });
    await p11.poll();
    expect(p11.view?.stage).toBe("roles");
    expect(p11.view?.game).toBeNull();
  });
  it("the same group number in a different activity is a different room", async () => {
    const { svc, phone } = await setup();
    const other = await svc.createActivity({ title: "Other", words: SAMPLE_SET.words });
    if (!other.ok) throw new Error();
    const a = phone("7", "Aki"), x = phone("7", "Xena", other.activity.id), b = phone("7", "Ben");
    await a.join(); await x.join();
    expect(x.view?.stage).toBe("waiting");
    await b.join();
    expect(b.view?.partner?.name).toBe("Aki");
  });
  it("rejects unknown activities, bad groups and blank names", async () => {
    const { phone } = await setup();
    expect(await phone("7", "A", "nope").join()).toMatchObject({ ok: false, code: "no_activity" });
    expect(await phone("x", "A").join()).toMatchObject({ ok: false, code: "bad_group" });
    expect(await phone("7", "   ").join()).toMatchObject({ ok: false, code: "bad_name" });
  });
  it("sanitises names", async () => {
    const { phone } = await setup();
    const p = phone("3", "  <b>Aki</b>\u0007  with a very long name indeed  ");
    await p.join();
    expect(p.view!.you.name.length).toBeLessThanOrEqual(16);
    expect(p.view!.you.name).not.toMatch(/[<>]/);
  });
});

describe("secure session recovery", () => {
  it("a refreshed phone with its token returns to the same seat and state", async () => {
    const { a } = await startGame();
    const before = a.view!.game!.players.map((p) => p.score);
    const refreshed = new Phone(a.svc, a.activityId, a.group, "");
    refreshed.token = a.token;
    expect(await refreshed.join()).toMatchObject({ ok: true, rejoined: true, seat: 0 });
    expect(refreshed.view!.game!.players.map((p) => p.score)).toEqual(before);
    expect(refreshed.view!.role).toBe(a.view!.role);
  });
  it("without the token nobody can take over a full group, even with the same name", async () => {
    const { svc, activity, a } = await startGame();
    expect(await new Phone(svc, activity.id, "7", "Aki").join()).toMatchObject({ ok: false, code: "full" });
    const guessed = new Phone(svc, activity.id, "7", "Aki");
    guessed.token = "0".repeat(32);
    expect(await guessed.join()).toMatchObject({ ok: false });
    expect(await guessed.poll()).toMatchObject({ ok: false, code: "unauthorized" });
    expect((await a.poll()).ok).toBe(true);
  });
});

describe("role confirmation", () => {
  const pair = async () => { const e = await setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"); await a.join(); await b.join(); return { ...e, a, b }; };
  it("one proposes, only the partner can confirm; then each phone gets its own role", async () => {
    const { a, b } = await pair();
    await a.act({ type: "PROPOSE_ROLES", giver: "me" });
    expect(await a.act({ type: "CONFIRM_ROLES" })).toMatchObject({ ok: true, applied: false });
    await b.poll();
    expect(b.view?.proposal).toMatchObject({ giverName: "Aki", takerName: "Ben", youProposed: false, youAreGiver: false });
    expect(await b.act({ type: "CONFIRM_ROLES" })).toMatchObject({ ok: true, applied: true });
    await a.poll();
    expect(a.view).toMatchObject({ stage: "playing", role: "giver" });
    expect(b.view).toMatchObject({ stage: "playing", role: "taker" });
    expect(a.view?.game?.switchKind).toBe("intro");
  });
  it("swapping is a new proposal that the original proposer must confirm", async () => {
    const { a, b } = await pair();
    await a.act({ type: "PROPOSE_ROLES", giver: "me" });
    await b.act({ type: "PROPOSE_ROLES", giver: "me" });
    expect(await b.act({ type: "CONFIRM_ROLES" })).toMatchObject({ applied: false });
    await a.act({ type: "CONFIRM_ROLES" });
    await b.poll();
    expect(b.view?.role).toBe("giver");
  });
  it("can't propose roles while alone", async () => {
    const e = await setup(); const a = e.phone("7", "Aki"); await a.join();
    expect(await a.act({ type: "PROPOSE_ROLES", giver: "me" })).toMatchObject({ ok: true, applied: false });
  });
  it("a player can leave before the game starts, freeing the seat", async () => {
    const e = await setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"), c = e.phone("7", "Cleo"); await a.join(); await b.join();
    expect(await b.act({ type: "LEAVE" })).toMatchObject({ ok: true, applied: true, view: null });
    expect((await c.join()).ok).toBe(true);
    await a.poll();
    expect(a.view?.partner?.name).toBe("Cleo");
  });
});

describe("privacy (enforced by what the server sends)", () => {
  it("the Taker never receives the answer, definition, example, accepted answers or hints", async () => {
    const { activity, svc, takerPhone: t, giverPhone: g } = await startGame();
    await g.act({ type: "CONTINUE" }); await t.poll();
    await g.act({ type: "PICK", wordId: activity.words[5].id });
    await g.act({ type: "REVEAL_HINT" });
    await t.poll();
    const json = JSON.stringify(t.view).toLowerCase();
    for (const w of activity.words) for (const s of secretsOf(w)) expect(json, `leaked "${s}"`).not.toContain(s.toLowerCase());
    expect(t.view!.game!.hintsUsed).toBe(1);
    const raw = JSON.stringify(await svc.getView({ activityId: activity.id, group: "7", token: t.token })).toLowerCase();
    expect(raw).not.toContain("reluctant");
  });
  it("the Giver sees the current word and its hints — and nothing about future words", async () => {
    const { activity, giverPhone: g } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[5].id });
    const w = giverWordOf(g);
    expect(w).toMatchObject({ word: "reluctant", meaning: activity.words[5].meaning });
    expect(w.hints).toEqual(activity.words[5].hints);
    const json = JSON.stringify(g.view).toLowerCase();
    for (const other of activity.words.filter((x) => x.id !== w.id)) for (const s of secretsOf(other)) expect(json, `future word leaked "${s}"`).not.toContain(s.toLowerCase());
  });
  it("on the board nobody receives any unsolved word", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" }); await t.poll();
    for (const p of [g, t]) {
      const json = JSON.stringify(p.view).toLowerCase();
      for (const w of activity.words) expect(json).not.toContain(`"${w.word.toLowerCase()}"`);
    }
  });
  it("roles come from the token, not from anything the client sends", async () => {
    const { svc, activity, takerPhone: t } = await startGame();
    const r = await svc.act({ activityId: activity.id, group: "7", token: t.token, opId: "q", action: { type: "REVEAL_HINT", role: "giver", seat: 0 } });
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    const r2 = await svc.act({ activityId: activity.id, group: "7", token: t.token, action: { type: "PICK", wordId: activity.words[0].id, role: "giver" } });
    expect(r2).toMatchObject({ ok: false, code: "forbidden" });
    await t.poll();
    expect(t.view!.role).toBe("taker");
  });
});

describe("permissions", () => {
  it("only the Giver picks and controls hints; only the Taker answers", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" });
    expect(await t.act({ type: "PICK", wordId: activity.words[0].id })).toMatchObject({ ok: false, code: "forbidden" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    expect(await t.act({ type: "REVEAL_HINT" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await t.act({ type: "ADJUST_HINTS", delta: 1 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await g.act({ type: "GUESS", text: "umbrella" })).toMatchObject({ ok: false, code: "forbidden" });
    await g.poll();
    expect(g.view!.game!.phase).toBe("round");
    expect(g.view!.game!.players.map((p) => p.score)).toEqual([0, 0]);
  });
  it("rejects malformed actions and actions before the game starts", async () => {
    const e = await setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"); await a.join(); await b.join();
    expect(await a.act({ type: "GUESS", text: "x" })).toMatchObject({ ok: false, code: "bad_action" });
    expect(await e.svc.act({ activityId: e.activity.id, group: "7", token: a.token, action: { type: "HACK" } })).toMatchObject({ ok: false, code: "bad_action" });
    expect(await e.svc.act({ activityId: e.activity.id, group: "7", token: a.token, action: null })).toMatchObject({ ok: false, code: "bad_action" });
    expect(await e.svc.act({ activityId: e.activity.id, group: "7", token: "", action: { type: "SKIP" } })).toMatchObject({ ok: false, code: "unauthorized" });
  });
});

describe("synchronised play", () => {
  it("hint counting by the Giver shows up on the Taker's phone", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    await t.poll();
    expect(t.view!.game!.currentWordId).toBe(activity.words[0].id);
    await g.act({ type: "REVEAL_HINT" });
    await g.act({ type: "ADJUST_HINTS", delta: 1 });
    await t.poll();
    expect(t.view!.game).toMatchObject({ hintsUsed: 2, revealedHints: 1 });
    expect(giverWordOf(g).hints[0]).toBe(activity.words[0].hints[0]);
  });
  it("a wrong answer is visible to the Giver; the right one scores for both", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    await t.act({ type: "GUESS", text: "raincoat" });
    await g.poll();
    expect(g.view!.game!.feedback).toMatchObject({ kind: "wrong", guess: "raincoat" });
    await g.act({ type: "REVEAL_HINT" });
    await t.act({ type: "GUESS", text: "Umbrella" });
    await g.poll();
    for (const p of [g, t]) {
      expect(p.view!.game!.phase).toBe("reveal");
      expect(p.view!.game!.lastResult).toMatchObject({ outcome: "solved", takerPoints: 85, giverPoints: 43 });
    }
    expect(t.view!.game!.words[0].word).toBe("umbrella");
    expect(t.view!.game!.players[t.view!.you.seat].score).toBe(85);
    expect(t.view!.game!.players[g.view!.you.seat].score).toBe(43);
  });
  it("never awards points twice: duplicate submissions, retries and stale answers are ignored", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    expect(await t.act({ type: "GUESS", text: "umbrella" }, "same-op")).toMatchObject({ applied: true });
    expect(await t.act({ type: "GUESS", text: "umbrella" }, "same-op")).toMatchObject({ ok: true, applied: false });
    expect(await t.act({ type: "GUESS", text: "umbrella" }, "another-op")).toMatchObject({ ok: true, applied: false });
    await g.act({ type: "ADJUST_HINTS", delta: 1 });
    await g.poll();
    expect(g.view!.game!.players.map((p) => p.score).sort((a, b) => b - a)).toEqual([100, 50]);
    expect(g.view!.game!.history).toHaveLength(1);
  });
  it("retrying the same hint request does not double-count", async () => {
    const { activity, giverPhone: g } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    await g.act({ type: "ADJUST_HINTS", delta: 1 }, "h1");
    await g.act({ type: "ADJUST_HINTS", delta: 1 }, "h1");
    expect(g.view!.game!.hintsUsed).toBe(1);
  });
  it("skipping works from either phone and scores nothing", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[2].id });
    await t.act({ type: "SKIP" });
    await g.poll();
    expect(g.view!.game).toMatchObject({ phase: "reveal" });
    expect(g.view!.game!.lastResult).toMatchObject({ outcome: "skipped", takerPoints: 0 });
  });
  it("roles alternate after every word on both phones", async () => {
    const { activity, a, b } = await startGame("a");
    const roles: string[][] = [];
    for (let i = 0; i < 4; i++) {
      await a.poll(); await b.poll();
      roles.push([a.view!.role!, b.view!.role!]);
      const giver = a.view!.role === "giver" ? a : b, taker = giver === a ? b : a;
      await giver.act({ type: "CONTINUE" });
      await giver.act({ type: "PICK", wordId: activity.words[i].id });
      await taker.act({ type: "GUESS", text: activity.words[i].word });
      await giver.act({ type: "NEXT" }); await taker.act({ type: "NEXT" });
    }
    expect(roles).toEqual([["giver", "taker"], ["taker", "giver"], ["giver", "taker"], ["taker", "giver"]]);
  });
  it("plays all ten words to a winner shown on both phones, then supports play-again", async () => {
    const { activity, a, b } = await startGame("a");
    for (let i = 0; i < 10; i++) {
      await a.poll(); await b.poll();
      const giver = a.view!.role === "giver" ? a : b, taker = giver === a ? b : a;
      await giver.act({ type: "CONTINUE" });
      await giver.act({ type: "PICK", wordId: activity.words[i].id });
      if (taker === a) await taker.act({ type: "GUESS", text: activity.words[i].word });
      else await taker.act({ type: "SKIP" });
      await taker.act({ type: "NEXT" });
    }
    await a.poll(); await b.poll();
    for (const p of [a, b]) {
      expect(p.view!.game!.phase).toBe("final");
      expect(p.view!.game!.players.map((x) => x.score)).toEqual([500, 250]);
      expect(p.view!.game!.history).toHaveLength(10);
    }
    await a.act({ type: "PLAY_AGAIN" }); await b.poll();
    expect(b.view).toMatchObject({ stage: "roles", game: null });
  });
  it("a tie is reported identically to both", async () => {
    const { activity, a, b } = await startGame("a");
    for (let i = 0; i < 10; i++) {
      await a.poll(); await b.poll();
      const giver = a.view!.role === "giver" ? a : b, taker = giver === a ? b : a;
      await giver.act({ type: "CONTINUE" });
      await giver.act({ type: "PICK", wordId: activity.words[i].id });
      await taker.act({ type: "GUESS", text: activity.words[i].word });
      await taker.act({ type: "NEXT" });
    }
    await a.poll(); await b.poll();
    expect(a.view!.game!.players[0].score).toBe(a.view!.game!.players[1].score);
    expect(b.view!.game!.players.map((p) => p.score)).toEqual(a.view!.game!.players.map((p) => p.score));
  });
});

describe("polling and versions", () => {
  it("`since` avoids resending unchanged state and every change bumps the version", async () => {
    const { activity, giverPhone: g, takerPhone: t, svc } = await startGame();
    await t.poll();
    const v = t.view!.version;
    expect(await svc.getView({ activityId: activity.id, group: "7", token: t.token, since: v })).toMatchObject({ ok: true, unchanged: true, version: v });
    await g.act({ type: "CONTINUE" });
    expect(await svc.getView({ activityId: activity.id, group: "7", token: t.token, since: v })).toMatchObject({ ok: true, unchanged: false });
  });
  it("an unchanged game is NOT reported as unchanged when the partner's connection changed", async () => {
    const { giverPhone: g, takerPhone: t, advance } = await startGame();
    await g.poll(); await t.poll();
    const v = g.view!.version;
    expect(await g.poll({ since: v, partnerWas: true })).toMatchObject({ unchanged: true });
    advance((PRESENCE_SECONDS + 1) * 1000); // the Taker goes silent
    const r = await g.poll({ since: v, partnerWas: true });
    expect(r).toMatchObject({ ok: true, unchanged: false });
    expect(g.view!.partner!.connected).toBe(false);
    expect(g.view!.version).toBe(v); // the game itself did not change
    expect(await g.poll({ since: v, partnerWas: false })).toMatchObject({ unchanged: true }); // nothing new to report
  });
});

describe("connection interruption", () => {
  it("shows the partner as disconnected after silence, and recovers without losing the game", async () => {
    const { activity, giverPhone: g, takerPhone: t, advance } = await startGame("a");
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    await g.act({ type: "REVEAL_HINT" });
    await t.poll();
    await g.poll();
    expect(g.view!.partner!.connected).toBe(true);
    advance((PRESENCE_SECONDS - 2) * 1000);
    await g.poll();
    expect(g.view!.partner!.connected).toBe(true);
    advance(4000);
    await g.poll();
    expect(g.view!.partner!.connected).toBe(false);
    expect(g.view!.game!.hintsUsed).toBe(1);
    expect(await t.join()).toMatchObject({ ok: true, rejoined: true });
    expect(t.view!.game!.hintsUsed).toBe(1);
    expect(t.view!.game!.currentWordId).toBe(activity.words[0].id);
    await g.poll();
    expect(g.view!.partner!.connected).toBe(true);
    await t.act({ type: "GUESS", text: "umbrella" });
    await g.poll();
    expect(g.view!.game!.phase).toBe("reveal");
  });
  it("expired activities are rejected cleanly", async () => {
    const { phone, advance } = await setup();
    advance(25 * 60 * 60 * 1000);
    expect(await phone("7", "Aki").join()).toMatchObject({ ok: false, code: "no_activity" });
  });
});

// ======================================================================================================
// Shared storage: the situation on Vercel, where every request may hit a different instance.
// ======================================================================================================

describe("shared state across independent server instances (Vercel)", () => {
  it("phones served by DIFFERENT instances share one game: join, roles, hints, answers, scores, winner", async () => {
    let now = 5_000_000;
    const kv = new MemoryKV(() => now);
    const A = new ClassService(kv, () => now), B = new ClassService(kv, () => now); // two "serverless instances", no shared memory except kv
    const created = await A.createActivity({ title: "T", words: SAMPLE_SET.words });
    if (!created.ok) throw new Error();
    const id = created.activity.id;
    expect(await B.getActivityInfo(id)).toMatchObject({ title: "T", wordCount: 10 }); // created on A, read on B
    const aki = new Phone(A, id, "3", "Aki"), ben = new Phone(B, id, "3", "Ben");
    await aki.join(); await ben.join();
    await aki.poll();
    expect(aki.view?.partner?.name).toBe("Ben");
    await aki.act({ type: "PROPOSE_ROLES", giver: "me" });
    await ben.act({ type: "CONFIRM_ROLES" });
    // now alternate which instance serves each phone request
    const via = (p: Phone, s: ClassService) => { p.svc = s; return p; };
    await via(aki, B).poll(); await via(ben, A).poll();
    expect([aki.view!.role, ben.view!.role]).toEqual(["giver", "taker"]);
    await via(aki, A).act({ type: "CONTINUE" });
    await via(aki, B).act({ type: "PICK", wordId: SAMPLE_SET.words[0].id });
    await via(aki, A).act({ type: "ADJUST_HINTS", delta: 1 });
    await via(ben, B).poll();
    expect(ben.view!.game).toMatchObject({ hintsUsed: 1, phase: "round" });
    expect(JSON.stringify(ben.view).toLowerCase()).not.toContain("umbrella");
    await via(ben, A).act({ type: "GUESS", text: "umbrella" });
    await via(aki, B).poll();
    expect(aki.view!.game!.lastResult).toMatchObject({ outcome: "solved", takerPoints: 85, giverPoints: 43 });
    // a third player on a third instance is still rejected
    expect(await new Phone(new ClassService(kv, () => now), id, "3", "Cleo").join()).toMatchObject({ ok: false, code: "full" });
  });
  it("a phone's session survives the instance that created it going away", async () => {
    const kv = new MemoryKV();
    const first = new ClassService(kv);
    const created = await first.createActivity({ title: "T", words: SAMPLE_SET.words });
    if (!created.ok) throw new Error();
    const p = new Phone(first, created.activity.id, "9", "Aki");
    await p.join();
    const replacement = new ClassService(kv); // a brand-new instance (cold start)
    p.svc = replacement;
    expect((await p.poll()).ok).toBe(true);
    expect(await p.join()).toMatchObject({ ok: true, rejoined: true });
  });
});

describe("concurrent requests", () => {
  it("simultaneous joins: exactly two players get seats (distinct), the rest are rejected", async () => {
    for (let round = 0; round < 5; round++) {
      const { phone } = await setup();
      const results = await Promise.all(["A", "B", "C", "D"].map((n) => phone("5", n).join()));
      const ok = results.filter((r) => r.ok);
      expect(ok).toHaveLength(2);
      expect(new Set(ok.map((r) => (r.ok ? r.seat : -1))).size).toBe(2);
      expect(results.filter((r) => !r.ok && r.code === "full")).toHaveLength(2);
    }
  });
  it("simultaneous hint presses by the Giver are all counted (no lost updates)", async () => {
    const { activity, giverPhone: g } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    await Promise.all(Array.from({ length: 8 }, (_, i) => g.act({ type: "ADJUST_HINTS", delta: 1 }, `hint-${i}`)));
    await g.poll();
    expect(g.view!.game!.hintsUsed).toBe(8);
  });
  it("two simultaneous correct answers score exactly once", async () => {
    for (let round = 0; round < 5; round++) {
      const { activity, giverPhone: g, takerPhone: t } = await startGame();
      await g.act({ type: "CONTINUE" });
      await g.act({ type: "PICK", wordId: activity.words[0].id });
      await Promise.all([t.act({ type: "GUESS", text: "umbrella" }, "x1"), t.act({ type: "GUESS", text: "umbrella" }, "x2"), t.act({ type: "GUESS", text: "umbrella" }, "x1")]);
      await g.poll();
      expect(g.view!.game!.history).toHaveLength(1);
      expect(g.view!.game!.players.map((p) => p.score).sort((a, b) => b - a)).toEqual([100, 50]);
    }
  });
  it("a Giver hint and a Taker answer at the same instant both apply, in a consistent order", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    await Promise.all([g.act({ type: "ADJUST_HINTS", delta: 1 }), t.act({ type: "GUESS", text: "raincoat" })]);
    await g.poll();
    expect(g.view!.game!.hintsUsed).toBe(1);
    expect(g.view!.game!.wrongGuesses).toBe(1);
  });
  it("when another request wins the race, the change is re-applied on top of the fresh state", async () => {
    const { activity, kv, giverPhone: g, takerPhone: t, svc, clock } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    // Interfere with the next write: just before it lands, a competing request (via another instance) changes the room.
    const rival = new ClassService(kv, clock);
    const rivalG = new Phone(rival, activity.id, "7", "Aki"); rivalG.token = g.token;
    let interfered = false;
    const racing: KV = {
      get: (k) => kv.get(k), set: (k, v, ttl) => kv.set(k, v, ttl), pipeline: (o: KvOp[]) => kv.pipeline(o), incr: (k, ttl) => kv.incr(k, ttl),
      async cas(k, v, val, ttl) {
        if (!interfered) { interfered = true; await rivalG.act({ type: "ADJUST_HINTS", delta: 1 }, "rival"); }
        return kv.cas(k, v, val, ttl);
      },
    };
    const mine = new ClassService(racing, clock);
    const r = await mine.act({ activityId: activity.id, group: "7", token: t.token, opId: "mine", action: { type: "GUESS", text: "raincoat" } });
    expect(r).toMatchObject({ ok: true, applied: true });
    await svc.getView({ activityId: activity.id, group: "7", token: g.token });
    await g.poll();
    expect(g.view!.game).toMatchObject({ hintsUsed: 1, wrongGuesses: 1 }); // neither change was lost
  });
  it("gives up politely (busy) if the room never stops changing", async () => {
    const { activity, kv, takerPhone: t, giverPhone: g, clock } = await startGame();
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[0].id });
    const alwaysLose: KV = { get: (k) => kv.get(k), set: (k, v, ttl) => kv.set(k, v, ttl), pipeline: (o) => kv.pipeline(o), incr: (k, ttl) => kv.incr(k, ttl), cas: async () => false };
    const r = await new ClassService(alwaysLose, clock).act({ activityId: activity.id, group: "7", token: t.token, opId: "z", action: { type: "SKIP" } });
    expect(r).toMatchObject({ ok: false, code: "busy" });
    await g.poll();
    expect(g.view!.game!.phase).toBe("round"); // nothing was half-applied
  });
});

describe("storage trouble is handled, not crashed on", () => {
  const broken: KV = {
    get: async () => { throw new KvError("down"); }, set: async () => { throw new KvError("down"); },
    cas: async () => { throw new KvError("down"); }, pipeline: async () => { throw new KvError("down"); }, incr: async () => { throw new KvError("down"); },
  };
  it("returns a friendly, retryable 'unavailable' error for every operation", async () => {
    const svc = new ClassService(broken);
    expect(await svc.createActivity({ title: "T", words: SAMPLE_SET.words })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await svc.join({ activityId: "x", group: "1", name: "A" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await svc.getView({ activityId: "x", group: "1", token: "t" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await svc.act({ activityId: "x", group: "1", token: "t", action: { type: "SKIP" } })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await svc.getActivityInfo("x")).toMatchObject({ ok: false, code: "unavailable" });
  });
  it("a missing storage configuration on a serverless host is reported, never silently replaced by memory", async () => {
    const { kvFromEnv } = await import("./kv");
    const svc = new ClassService(() => kvFromEnv({ VERCEL: "1" }));
    const r = await svc.join({ activityId: "x", group: "1", name: "A" });
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(r)).toMatch(/isn't set up/);
  });
});

describe("operating cost (storage commands)", () => {
  function counting(kv: KV) {
    const log = { gets: 0, sets: 0, cas: 0, pipelineCmds: 0, roundTrips: 0 };
    const c: KV = {
      get: (k) => (log.gets++, log.roundTrips++, kv.get(k)),
      set: (k, v, t) => (log.sets++, log.roundTrips++, kv.set(k, v, t)),
      cas: (k, e, v, t) => (log.cas++, log.roundTrips++, kv.cas(k, e, v, t)),
      pipeline: (o) => (log.pipelineCmds += o.length, log.roundTrips++, kv.pipeline(o)),
      incr: (k, t) => kv.incr(k, t),
    };
    return { c, log, reset: () => Object.assign(log, { gets: 0, sets: 0, cas: 0, pipelineCmds: 0, roundTrips: 0 }) };
  }
  it("a routine poll is 3 commands in 2 round trips and never writes the room", async () => {
    const { kv, activity, phone, clock } = await setup();
    const k = counting(kv);
    const svc = new ClassService(k.c, clock);
    const a = phone("7", "Aki", activity.id, svc), b = phone("7", "Ben", activity.id, svc);
    await a.join(); await b.join(); await a.poll();
    k.reset();
    await a.poll({ since: a.view!.version, partnerWas: true });
    expect(k.log).toMatchObject({ gets: 1, pipelineCmds: 2, cas: 0, sets: 0, roundTrips: 2 });
    expect(k.log.gets + k.log.pipelineCmds).toBe(3);
  });
  it("the client polls gently (≥ 2.5 s visible, ≥ 6 s hidden) and reports the partner state", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../components/class/useClassSession.ts", import.meta.url), "utf8");
    expect(Number(src.match(/const POLL_MS = (\d+)/)![1])).toBeGreaterThanOrEqual(2500);
    expect(Number(src.match(/const POLL_HIDDEN_MS = (\d+)/)![1])).toBeGreaterThanOrEqual(6000);
    expect(src).toMatch(/&pc=\$\{partnerRef\.current\}/);
  });
});

describe("finished words don't leak later answers (examples can mention other target words)", () => {
  it("a Taker never receives the example, meaning or hints of earlier words — only the word currently on the reveal screen", async () => {
    const { activity, giverPhone: g, takerPhone: t } = await startGame();
    // sample set: the example of word 2 (scissors) contains word 4 (borrow)
    expect(activity.words[1].example.toLowerCase()).toContain("borrow");
    await g.act({ type: "CONTINUE" });
    await g.act({ type: "PICK", wordId: activity.words[1].id });
    await t.act({ type: "GUESS", text: "scissors" });
    await t.poll();
    // on the reveal screen the finished word's full text is shown to both (that is the lesson)…
    expect(t.view!.game!.words[1]).toMatchObject({ word: "scissors", example: activity.words[1].example });
    await g.act({ type: "NEXT" });
    await g.poll(); await t.poll();
    // …but once play moves on, only its NAME remains
    for (const p of [g, t]) {
      const w = p.view!.game!.words[1];
      expect(w.word).toBe("scissors");
      expect(w.example + w.meaning + w.hints.join("") + (w.accept ?? []).join("")).toBe("");
      expect(JSON.stringify(p.view).toLowerCase()).not.toContain("borrow your scissors");
    }
  });
});

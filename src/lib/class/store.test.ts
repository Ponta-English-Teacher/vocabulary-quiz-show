import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { ClassStore, normalizeGroup, PRESENCE_MS, type ClassActivity } from "./store";
import type { ClassView, ClientAction } from "./types";

/** A simulated phone: it only ever holds its own token and the last view it was sent. */
class Phone {
  token = "";
  view: ClassView | null = null;
  constructor(public store: ClassStore, public activityId: string, public group: string, public name: string) {}
  private n = 0;
  join() {
    const r = this.store.join({ activityId: this.activityId, group: this.group, name: this.name, token: this.token || undefined });
    if (r.ok) { this.token = r.token; this.view = r.view; }
    return r;
  }
  poll() {
    const r = this.store.getView({ activityId: this.activityId, group: this.group, token: this.token });
    if (r.ok && !r.unchanged) this.view = r.view;
    return r;
  }
  act(action: ClientAction, opId = `${this.name}-${++this.n}`) {
    const r = this.store.act({ activityId: this.activityId, group: this.group, token: this.token, opId, action });
    if (r.ok && r.view) this.view = r.view;
    return r;
  }
}

function setup() {
  let now = 1_000_000;
  const store = new ClassStore(() => now);
  const created = store.createActivity({ title: SAMPLE_SET.title, words: SAMPLE_SET.words });
  if (!created.ok) throw new Error("setup");
  const activity: ClassActivity = created.activity;
  const phone = (group: string, name: string, act = activity.id) => new Phone(store, act, group, name);
  return { store, activity, phone, advance: (ms: number) => { now += ms; store.sweep(); } };
}

/** Pair two phones and start the game with `giver` as Giver. */
function startGame(giver: "a" | "b" = "a") {
  const env = setup();
  const a = env.phone("7", "Aki"), b = env.phone("7", "Ben");
  a.join(); b.join();
  const [proposer, confirmer] = giver === "a" ? [a, b] : [b, a];
  proposer.act({ type: "PROPOSE_ROLES", giver: "me" });
  confirmer.act({ type: "CONFIRM_ROLES" });
  a.poll(); b.poll();
  return { ...env, a, b, giverPhone: giver === "a" ? a : b, takerPhone: giver === "a" ? b : a };
}
const giverWordOf = (p: Phone) => p.view!.game!.words.find((w) => w.id === p.view!.game!.currentWordId)!;

describe("group numbers", () => {
  it("normalises simple numbers and rejects junk", () => {
    expect(normalizeGroup("07")).toBe("7");
    expect(normalizeGroup(" 12 ")).toBe("12");
    for (const bad of ["", "0", "abc", "1.5", "1000", "-1", null, undefined, {}]) expect(normalizeGroup(bad)).toBeNull();
  });
});

describe("pairing", () => {
  it("two players join one group: first waits, second completes the pair", () => {
    const { phone } = setup();
    const a = phone("7", "Aki"), b = phone("7", "Ben");
    expect(a.join().ok).toBe(true);
    expect(a.view).toMatchObject({ stage: "waiting", partner: null, you: { seat: 0, name: "Aki" } });
    expect(b.join().ok).toBe(true);
    expect(b.view).toMatchObject({ stage: "roles", you: { seat: 1 }, partner: { name: "Aki", connected: true } });
    a.poll();
    expect(a.view).toMatchObject({ stage: "roles", partner: { name: "Ben", connected: true } });
  });
  it("rejects a third player and does not disturb the pair", () => {
    const { phone } = setup();
    const a = phone("7", "Aki"), b = phone("7", "Ben"), c = phone("7", "Cleo");
    a.join(); b.join();
    const r = c.join();
    expect(r).toMatchObject({ ok: false, code: "full" });
    expect(c.poll()).toMatchObject({ ok: false, code: "unauthorized" });
    a.poll();
    expect(a.view?.partner?.name).toBe("Ben");
  });
  it("keeps groups 1 and 11 (and other groups) completely separate", () => {
    const { phone } = setup();
    const p1 = phone("1", "A1"), p1b = phone("1", "B1"), p11 = phone("11", "A11"), p11b = phone("11", "B11");
    p1.join(); p11.join(); p1b.join(); p11b.join();
    expect(p1.view?.partner).toBeNull;
    p1.poll(); p11.poll();
    expect(p1.view?.partner?.name).toBe("B1");
    expect(p11.view?.partner?.name).toBe("B11");
    // A token from group 1 is useless in group 11
    const stolen = p11.store.getView({ activityId: p11.activityId, group: "11", token: p1.token });
    expect(stolen).toMatchObject({ ok: false, code: "unauthorized" });
    // game progress in one group never appears in the other
    p1.act({ type: "PROPOSE_ROLES", giver: "me" }); p1b.act({ type: "CONFIRM_ROLES" });
    p11.poll();
    expect(p11.view?.stage).toBe("roles");
    expect(p11.view?.game).toBeNull();
  });
  it("the same group number in a different activity is a different room", () => {
    const { store, phone, activity } = setup();
    const other = store.createActivity({ title: "Other", words: SAMPLE_SET.words });
    if (!other.ok) throw new Error();
    const a = phone("7", "Aki"), x = phone("7", "Xena", other.activity.id), b = phone("7", "Ben");
    a.join(); x.join();
    expect(x.view?.stage).toBe("waiting"); // did NOT connect to Aki
    b.join();
    expect(b.view?.partner?.name).toBe("Aki");
    expect(activity.id).not.toBe(other.activity.id);
  });
  it("rejects unknown activities, bad groups and blank names", () => {
    const { phone } = setup();
    expect(phone("7", "A", "nope").join()).toMatchObject({ ok: false, code: "no_activity" });
    expect(phone("x", "A").join()).toMatchObject({ ok: false, code: "bad_group" });
    expect(phone("7", "   ").join()).toMatchObject({ ok: false, code: "bad_name" });
  });
  it("sanitises names", () => {
    const { phone } = setup();
    const p = phone("3", "  <b>Aki</b>\u0007  with a very long name indeed  ");
    p.join();
    expect(p.view!.you.name.length).toBeLessThanOrEqual(16);
    expect(p.view!.you.name).not.toMatch(/[<>]/);
  });
});

describe("secure session recovery", () => {
  it("a refreshed phone with its token returns to the same seat and state", () => {
    const { phone, a, b } = (() => { const e = startGame(); return { ...e }; })();
    void phone;
    const before = a.view!.game!.players.map((p) => p.score);
    const refreshed = new Phone(a.store, a.activityId, a.group, ""); // blank name: token is what matters
    refreshed.token = a.token;
    const r = refreshed.join();
    expect(r).toMatchObject({ ok: true, rejoined: true, seat: 0 });
    expect(refreshed.view!.game!.players.map((p) => p.score)).toEqual(before);
    expect(refreshed.view!.role).toBe(a.view!.role);
    void b;
  });
  it("without the token nobody can take over a full group, even with the same name", () => {
    const { store, activity, a } = startGame();
    const imposter = new Phone(store, activity.id, "7", "Aki");
    expect(imposter.join()).toMatchObject({ ok: false, code: "full" });
    const guessed = new Phone(store, activity.id, "7", "Aki");
    guessed.token = "0".repeat(32);
    expect(guessed.join()).toMatchObject({ ok: false });
    expect(guessed.poll()).toMatchObject({ ok: false, code: "unauthorized" });
    expect(a.poll().ok).toBe(true);
  });
});

describe("role confirmation", () => {
  it("one proposes, only the partner can confirm; then each phone gets its own role", () => {
    const { a, b } = setup().phone && (() => { const e = setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"); a.join(); b.join(); return { a, b }; })();
    a.act({ type: "PROPOSE_ROLES", giver: "me" });
    expect(a.act({ type: "CONFIRM_ROLES" })).toMatchObject({ ok: true, applied: false }); // can't self-confirm
    b.poll();
    expect(b.view?.proposal).toMatchObject({ giverName: "Aki", takerName: "Ben", youProposed: false, youAreGiver: false });
    expect(b.act({ type: "CONFIRM_ROLES" })).toMatchObject({ ok: true, applied: true });
    a.poll();
    expect(a.view).toMatchObject({ stage: "playing", role: "giver" });
    expect(b.view).toMatchObject({ stage: "playing", role: "taker" });
    expect(a.view?.game?.switchKind).toBe("intro");
  });
  it("swapping is a new proposal that the original proposer must confirm", () => {
    const e = setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"); a.join(); b.join();
    a.act({ type: "PROPOSE_ROLES", giver: "me" });
    b.act({ type: "PROPOSE_ROLES", giver: "me" }); // Ben would rather explain
    expect(b.act({ type: "CONFIRM_ROLES" })).toMatchObject({ applied: false });
    a.act({ type: "CONFIRM_ROLES" });
    b.poll();
    expect(b.view?.role).toBe("giver");
  });
  it("can't propose roles while alone", () => {
    const e = setup(); const a = e.phone("7", "Aki"); a.join();
    expect(a.act({ type: "PROPOSE_ROLES", giver: "me" })).toMatchObject({ ok: true, applied: false });
  });
  it("a player can leave before the game starts, freeing the seat", () => {
    const e = setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"), c = e.phone("7", "Cleo"); a.join(); b.join();
    expect(b.act({ type: "LEAVE" })).toMatchObject({ ok: true, applied: true, view: null });
    expect(c.join().ok).toBe(true);
    a.poll();
    expect(a.view?.partner?.name).toBe("Cleo");
  });
});

describe("privacy (enforced by what the server sends)", () => {
  const secretsOf = (w: VocabWord) => [w.word, ...(w.accept ?? []), w.meaning, w.example, ...w.hints].filter(Boolean);

  it("the Taker never receives the answer, definition, example, accepted answers or hints", () => {
    const { activity, store, takerPhone: t, giverPhone: g } = startGame();
    g.act({ type: "CONTINUE" }); t.poll();
    g.act({ type: "PICK", wordId: activity.words[5].id }); // reluctant
    g.act({ type: "REVEAL_HINT" });
    t.poll();
    const json = JSON.stringify(t.view).toLowerCase();
    for (const w of activity.words) for (const s of secretsOf(w)) expect(json, `leaked "${s}"`).not.toContain(s.toLowerCase());
    expect(t.view!.game!.hintsUsed).toBe(1); // counts are fine
    expect(t.view!.game!.currentWordId).toBe(activity.words[5].id);
    // raw API response too
    const raw = JSON.stringify(store.getView({ activityId: activity.id, group: "7", token: t.token })).toLowerCase();
    expect(raw).not.toContain("reluctant");
  });
  it("the Giver sees the current word and its hints — and nothing about future words", () => {
    const { activity, giverPhone: g } = startGame();
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[5].id });
    const w = giverWordOf(g);
    expect(w).toMatchObject({ word: "reluctant", meaning: activity.words[5].meaning });
    expect(w.hints).toEqual(activity.words[5].hints);
    const json = JSON.stringify(g.view).toLowerCase();
    for (const other of activity.words.filter((x) => x.id !== w.id)) {
      for (const s of secretsOf(other)) expect(json, `future word leaked "${s}"`).not.toContain(s.toLowerCase());
    }
  });
  it("on the board nobody receives any unsolved word", () => {
    const { activity, giverPhone: g, takerPhone: t } = startGame();
    g.act({ type: "CONTINUE" }); t.poll();
    for (const p of [g, t]) {
      const json = JSON.stringify(p.view).toLowerCase();
      for (const w of activity.words) expect(json).not.toContain(`"${w.word.toLowerCase()}"`);
    }
  });
  it("roles come from the token, not from anything the client sends", () => {
    const { store, activity, takerPhone: t } = startGame();
    // extra junk fields (role, seat, giver) are ignored
    const r = store.act({ type: "x", activityId: activity.id, group: "7", token: t.token, opId: "q", action: { type: "REVEAL_HINT", role: "giver", seat: 0 } } as never);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    const r2 = store.act({ activityId: activity.id, group: "7", token: t.token, action: { type: "PICK", wordId: activity.words[0].id, role: "giver" } });
    expect(r2).toMatchObject({ ok: false, code: "forbidden" });
    expect(t.poll().ok).toBe(true);
    expect(t.view!.role).toBe("taker");
  });
});

describe("permissions", () => {
  it("only the Giver picks and controls hints; only the Taker answers", () => {
    const { activity, giverPhone: g, takerPhone: t } = startGame();
    g.act({ type: "CONTINUE" });
    expect(t.act({ type: "PICK", wordId: activity.words[0].id })).toMatchObject({ ok: false, code: "forbidden" });
    g.act({ type: "PICK", wordId: activity.words[0].id });
    expect(t.act({ type: "REVEAL_HINT" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(t.act({ type: "ADJUST_HINTS", delta: 1 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(g.act({ type: "GUESS", text: "umbrella" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(g.poll().ok && g.view!.game!.phase).toBe("round");
    expect(g.view!.game!.players.map((p) => p.score)).toEqual([0, 0]);
  });
  it("rejects malformed actions and actions before the game starts", () => {
    const e = setup(); const a = e.phone("7", "Aki"), b = e.phone("7", "Ben"); a.join(); b.join();
    expect(a.act({ type: "GUESS", text: "x" })).toMatchObject({ ok: false, code: "bad_action" });
    expect(e.store.act({ activityId: e.activity.id, group: "7", token: a.token, action: { type: "HACK" } })).toMatchObject({ ok: false, code: "bad_action" });
    expect(e.store.act({ activityId: e.activity.id, group: "7", token: a.token, action: null })).toMatchObject({ ok: false, code: "bad_action" });
    expect(e.store.act({ activityId: e.activity.id, group: "7", token: "", action: { type: "SKIP" } })).toMatchObject({ ok: false, code: "unauthorized" });
  });
});

describe("synchronised play", () => {
  it("hint counting by the Giver shows up on the Taker's phone, with revealed prepared hints", () => {
    const { activity, giverPhone: g, takerPhone: t } = startGame();
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[0].id });
    t.poll();
    expect(t.view!.game!.currentWordId).toBe(activity.words[0].id);
    g.act({ type: "REVEAL_HINT" });
    g.act({ type: "ADJUST_HINTS", delta: 1 });
    t.poll();
    expect(t.view!.game).toMatchObject({ hintsUsed: 2, revealedHints: 1 });
    expect(giverWordOf(g).hints[0]).toBe(activity.words[0].hints[0]);
  });
  it("a wrong answer from the Taker is visible to the Giver; the right one scores for both", () => {
    const { activity, giverPhone: g, takerPhone: t } = startGame();
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[0].id });
    t.act({ type: "GUESS", text: "raincoat" });
    g.poll();
    expect(g.view!.game!.feedback).toMatchObject({ kind: "wrong", guess: "raincoat" });
    g.act({ type: "REVEAL_HINT" });
    t.act({ type: "GUESS", text: "Umbrella" });
    g.poll();
    for (const p of [g, t]) {
      expect(p.view!.game!.phase).toBe("reveal");
      expect(p.view!.game!.lastResult).toMatchObject({ outcome: "solved", takerPoints: 85, giverPoints: 43 });
    }
    // the word is revealed to both once solved
    expect(t.view!.game!.words[0].word).toBe("umbrella");
    const takerSeat = t.view!.you.seat, giverSeat = g.view!.you.seat;
    expect(t.view!.game!.players[takerSeat].score).toBe(85);
    expect(t.view!.game!.players[giverSeat].score).toBe(43);
  });
  it("never awards points twice: duplicate submissions, retries and stale answers are ignored", () => {
    const { activity, giverPhone: g, takerPhone: t } = startGame();
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[0].id });
    const first = t.act({ type: "GUESS", text: "umbrella" }, "same-op");
    expect(first).toMatchObject({ applied: true });
    const retry = t.act({ type: "GUESS", text: "umbrella" }, "same-op"); // network retry
    const doubleTap = t.act({ type: "GUESS", text: "umbrella" }, "another-op"); // second tap
    expect(retry).toMatchObject({ ok: true, applied: false });
    expect(doubleTap).toMatchObject({ ok: true, applied: false });
    g.act({ type: "ADJUST_HINTS", delta: 1 }); // stale hint after solving
    g.poll();
    const scores = g.view!.game!.players.map((p) => p.score).sort((a, b) => b - a);
    expect(scores).toEqual([100, 50]);
    expect(g.view!.game!.history).toHaveLength(1);
  });
  it("retrying the same hint request does not double-count", () => {
    const { activity, giverPhone: g } = startGame();
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[0].id });
    g.act({ type: "ADJUST_HINTS", delta: 1 }, "h1");
    g.act({ type: "ADJUST_HINTS", delta: 1 }, "h1");
    expect(g.view!.game!.hintsUsed).toBe(1);
  });
  it("skipping works from either phone and scores nothing", () => {
    const { activity, giverPhone: g, takerPhone: t } = startGame();
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[2].id });
    t.act({ type: "SKIP" });
    g.poll();
    expect(g.view!.game).toMatchObject({ phase: "reveal" });
    expect(g.view!.game!.lastResult).toMatchObject({ outcome: "skipped", takerPoints: 0 });
  });
  it("roles alternate after every word on both phones", () => {
    const { activity, a, b } = startGame("a");
    const roles: string[][] = [];
    let words = [...activity.words];
    for (let i = 0; i < 4; i++) {
      a.poll(); b.poll();
      roles.push([a.view!.role!, b.view!.role!]);
      const giver = a.view!.role === "giver" ? a : b, taker = giver === a ? b : a;
      if (i === 0) giver.act({ type: "CONTINUE" }); else giver.act({ type: "CONTINUE" });
      giver.act({ type: "PICK", wordId: words[i].id });
      taker.act({ type: "GUESS", text: words[i].word });
      // either player advances; both pressing is harmless
      giver.act({ type: "NEXT" }); taker.act({ type: "NEXT" });
    }
    expect(roles).toEqual([["giver", "taker"], ["taker", "giver"], ["giver", "taker"], ["taker", "giver"]]);
    words = [];
  });
  it("plays all ten words to a winner shown on both phones, then supports play-again", () => {
    const { activity, a, b } = startGame("a");
    for (let i = 0; i < 10; i++) {
      a.poll(); b.poll();
      const giver = a.view!.role === "giver" ? a : b, taker = giver === a ? b : a;
      giver.act({ type: "CONTINUE" });
      giver.act({ type: "PICK", wordId: activity.words[i].id });
      // Aki (a) always scores: skip every word where Ben is Taker
      if (taker === a) taker.act({ type: "GUESS", text: activity.words[i].word });
      else taker.act({ type: "SKIP" });
      taker.act({ type: "NEXT" });
    }
    a.poll(); b.poll();
    for (const p of [a, b]) {
      expect(p.view!.game!.phase).toBe("final");
      expect(p.view!.game!.players.map((x) => x.score)).toEqual([500, 250]);
      expect(p.view!.game!.history).toHaveLength(10);
    }
    // final screen leaks nothing new but shows all words (they are all solved/skipped)
    a.act({ type: "PLAY_AGAIN" }); b.poll();
    expect(b.view).toMatchObject({ stage: "roles", game: null });
  });
  it("a tie is reported identically to both", () => {
    const { activity, a, b } = startGame("a");
    for (let i = 0; i < 10; i++) {
      a.poll(); b.poll();
      const giver = a.view!.role === "giver" ? a : b, taker = giver === a ? b : a;
      giver.act({ type: "CONTINUE" });
      giver.act({ type: "PICK", wordId: activity.words[i].id });
      taker.act({ type: "GUESS", text: activity.words[i].word });
      taker.act({ type: "NEXT" });
    }
    a.poll(); b.poll();
    expect(a.view!.game!.players[0].score).toBe(a.view!.game!.players[1].score);
    expect(b.view!.game!.players.map((p) => p.score)).toEqual(a.view!.game!.players.map((p) => p.score));
  });
});

describe("polling and versions", () => {
  it("`since` avoids resending unchanged state and every change bumps the version", () => {
    const { activity, giverPhone: g, takerPhone: t, store } = startGame();
    t.poll();
    const v = t.view!.version;
    const same = store.getView({ activityId: activity.id, group: "7", token: t.token, since: v });
    expect(same).toMatchObject({ ok: true, unchanged: true, version: v });
    g.act({ type: "CONTINUE" });
    const changed = store.getView({ activityId: activity.id, group: "7", token: t.token, since: v });
    expect(changed).toMatchObject({ ok: true, unchanged: false });
  });
});

describe("connection interruption", () => {
  it("shows the partner as disconnected after silence, and recovers without losing the game", () => {
    const { activity, a, b, giverPhone: g, takerPhone: t, advance } = startGame("a");
    void b;
    g.act({ type: "CONTINUE" });
    g.act({ type: "PICK", wordId: activity.words[0].id });
    g.act({ type: "REVEAL_HINT" });
    t.poll();
    expect(g.poll().ok && g.view!.partner!.connected).toBe(true);
    // Taker's phone goes quiet (loses signal) while the Giver keeps polling
    advance(PRESENCE_MS - 1000);
    g.poll();
    expect(g.view!.partner!.connected).toBe(true);
    advance(2000);
    g.poll();
    expect(g.view!.partner!.connected).toBe(false);
    expect(g.view!.game!.hintsUsed).toBe(1); // game state is untouched
    // Taker comes back with the same token
    const back = t.join();
    expect(back).toMatchObject({ ok: true, rejoined: true });
    expect(t.view!.game!.hintsUsed).toBe(1);
    expect(t.view!.game!.currentWordId).toBe(activity.words[0].id);
    g.poll();
    expect(g.view!.partner!.connected).toBe(true); // version bumped so the Giver's indicator flips back
    t.act({ type: "GUESS", text: "umbrella" });
    g.poll();
    expect(g.view!.game!.phase).toBe("reveal");
  });
  it("the sweep alone updates the version when a phone drops (no request needed)", () => {
    const { a, b, store, activity, advance } = startGame("a");
    a.poll(); const v = a.view!.version;
    advance(PRESENCE_MS + 500); // both silent; sweep marks both disconnected
    b.poll(); // b wakes up
    const r = store.getView({ activityId: activity.id, group: "7", token: b.token, since: v });
    expect(r).toMatchObject({ ok: true, unchanged: false });
  });
  it("expired activities are rejected cleanly", () => {
    const { store, phone, advance } = setup();
    advance(25 * 60 * 60 * 1000);
    expect(store.getActivityInfo("whatever")).toBeNull();
    expect(phone("7", "Aki").join()).toMatchObject({ ok: false, code: "no_activity" });
  });
});

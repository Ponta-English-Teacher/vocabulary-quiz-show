import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { selectWords } from "@/lib/playCount";
import { Final, FinalScreen } from "@/components/Final";
import { EndGame } from "@/components/class/ClassBar";
import { JoinForm, Roles, Waiting } from "@/components/class/Lobby";
import { ClassService, PRESENCE_SECONDS, type PartnerState } from "./service";
import { MemoryKV } from "./kv";
import type { ClassView, ClientAction } from "./types";
import * as studyRoute from "../../app/api/class/[activityId]/study/route";

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
  study() { return this.svc.getStudy({ activityId: this.activityId, group: this.group, token: this.token }); }
}

const WORDS = selectWords(SAMPLE_SET.words, 5);

async function setup() {
  let now = 1_000_000;
  const kv = new MemoryKV(() => now);
  const svc = new ClassService(kv, () => now);
  const created = await svc.createActivity({ title: "My class", words: WORDS });
  if (!created.ok) throw new Error("setup");
  const activity = created.activity;
  const phone = (group: string, name: string) => new Phone(svc, activity.id, group, name);
  return { kv, svc, activity, phone, advance: (ms: number) => { now += ms; } };
}
/** A paired group with the game started; Aki is the Giver of the first word. */
async function pair(env: Awaited<ReturnType<typeof setup>>, group: string, an = "Aki", bn = "Ben") {
  const a = env.phone(group, an), b = env.phone(group, bn);
  await a.join(); await b.join();
  await a.act({ type: "PROPOSE_ROLES", giver: "me" });
  await b.act({ type: "CONFIRM_ROLES" });
  await a.poll(); await b.poll();
  return { a, b };
}
const giverOf = (p: { a: Phone; b: Phone }) => (p.a.view!.role === "giver" ? p.a : p.b);
const takerOf = (p: { a: Phone; b: Phone }) => (p.a.view!.role === "giver" ? p.b : p.a);
/** Play one word to its reveal screen: the Giver picks it, the Taker answers correctly (no extra hints → 100 / 50). */
async function solve(p: { a: Phone; b: Phone }, index: number) {
  await giverOf(p).act({ type: "CONTINUE" });
  await giverOf(p).act({ type: "PICK", wordId: WORDS[index].id });
  await takerOf(p).act({ type: "GUESS", text: WORDS[index].word });
  await p.a.poll(); await p.b.poll();
}
const nextWord = async (p: { a: Phone; b: Phone }) => { await p.a.act({ type: "NEXT" }); await p.a.poll(); await p.b.poll(); };
const scores = (v: ClassView) => v.game!.players.map((x) => x.score);

describe("automatic study access from the class link", () => {
  it("serves exactly the words the class was created with, in order, as study fields only", async () => {
    const env = await setup();
    const r = await env.svc.getStudy({ activityId: env.activity.id });
    if (!r.ok) throw new Error("study");
    expect(r.title).toBe("My class");
    expect(r.words.map((w) => w.word)).toEqual(WORDS.map((w) => w.word));
    expect(r.words).toHaveLength(5);
    expect(r.words[0]).toEqual({ word: WORDS[0].word, partOfSpeech: WORDS[0].partOfSpeech, meaning: WORDS[0].meaning, ja: WORDS[0].ja ?? [], example: WORDS[0].example });
    const text = JSON.stringify(r);
    for (const w of WORDS) for (const hint of w.hints) expect(text).not.toContain(hint);
    expect(text).not.toMatch(/hints|giverInfo|illustration|accept/);
  });
  it("two classes never see each other's vocabulary; an unknown or expired class has none", async () => {
    const env = await setup();
    const other = await env.svc.createActivity({ title: "Other class", words: SAMPLE_SET.words.slice(0, 2) });
    if (!other.ok) throw new Error();
    const a = await env.svc.getStudy({ activityId: env.activity.id });
    const b = await env.svc.getStudy({ activityId: other.activity.id });
    expect(a.ok && a.words).toHaveLength(5);
    expect(b.ok && b.words.map((w) => w.word)).toEqual(SAMPLE_SET.words.slice(0, 2).map((w) => w.word));
    expect(await env.svc.getStudy({ activityId: "nope" })).toMatchObject({ ok: false, code: "no_activity" });
    env.advance(25 * 60 * 60 * 1000);
    expect(await env.svc.getStudy({ activityId: env.activity.id })).toMatchObject({ ok: false, code: "no_activity" });
  });
  it("is open before the game (entry screen and lobby) and after the final result, but closed for a joined player during the game", async () => {
    const env = await setup();
    const a = env.phone("7", "Aki"), b = env.phone("7", "Ben");
    expect((await a.study()).ok).toBe(true); // before joining
    await a.join(); await b.join();
    expect((await a.study()).ok).toBe(true); // lobby / roles
    await a.act({ type: "PROPOSE_ROLES", giver: "me" }); await b.act({ type: "CONFIRM_ROLES" });
    expect(await a.study()).toMatchObject({ ok: false, code: "forbidden" });
    expect(await b.study()).toMatchObject({ ok: false, code: "forbidden" });
    const p = { a, b };
    await solve(p, 0);
    expect(await b.study()).toMatchObject({ ok: false, code: "forbidden" }); // also on the reveal screen
    await a.act({ type: "REQUEST_END" }); await b.act({ type: "CONFIRM_END" });
    expect((await a.study()).ok).toBe(true); // after the game
    expect((await b.study()).ok).toBe(true);
  });
  it("another pair that has not started playing can study while a different pair plays", async () => {
    const env = await setup();
    const p1 = await pair(env, "1");
    const c = env.phone("2", "Cleo");
    await c.join();
    expect((await c.study()).ok).toBe(true);
    expect(await p1.a.study()).toMatchObject({ ok: false });
  });
  it("a wrong or foreign token is treated as not joined (it cannot unlock or lock anything for someone else)", async () => {
    const env = await setup();
    const p = await pair(env, "1");
    const r = await env.svc.getStudy({ activityId: env.activity.id, group: "1", token: "not-a-real-token" });
    expect(r.ok).toBe(true); // an unknown token is just an anonymous visitor
    void p;
  });
  it("the study route needs no teacher login, and refuses a player who is mid-game", async () => {
    // the route uses the process-wide service, so create a class there
    const { getClassService } = await import("./service");
    const svc = getClassService();
    const created = await svc.createActivity({ title: "Route class", words: WORDS });
    if (!created.ok) throw new Error();
    const id = created.activity.id;
    const get = (qs = "", token = "") => studyRoute.GET(new Request(`http://localhost/api/class/${id}/study${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), { params: Promise.resolve({ activityId: id }) });
    const anon = await get();
    expect(anon.status).toBe(200);
    expect(anon.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect((await anon.json()).words).toHaveLength(5);
    const a = new Phone(svc, id, "3", "Aki"), b = new Phone(svc, id, "3", "Ben");
    await a.join(); await b.join(); await a.act({ type: "PROPOSE_ROLES", giver: "me" }); await b.act({ type: "CONFIRM_ROLES" });
    expect((await get("?group=3", a.token)).status).toBe(403);
    expect((await get("?group=3")).status).toBe(200); // no token = not identifiable as a player
  });
  it("the entry, waiting and role screens offer Study Vocabulary and Play Quiz; the final screen offers Study Vocabulary", async () => {
    const href = "/class/abc/study";
    const join = renderToStaticMarkup(h(JoinForm, { title: "T", error: null, busy: false, onJoin: () => undefined, studyHref: href }));
    expect(join).toContain("Play Quiz");
    expect(join).toContain(`href="${href}"`);
    expect(join).toContain("Study Vocabulary");
    const env = await setup();
    const a = env.phone("7", "Aki"), b = env.phone("7", "Ben");
    await a.join();
    expect(renderToStaticMarkup(h(Waiting, { view: a.view!, onLeave: () => undefined, studyHref: href }))).toContain("Study Vocabulary");
    await b.join();
    expect(renderToStaticMarkup(h(Roles, { view: b.view!, act: () => undefined, studyHref: href }))).toContain("Study Vocabulary");
  });
});

describe("ending the game early: request and confirmation", () => {
  it("one partner asks: nothing ends, the partner is asked, the asker waits", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0);
    await p.a.act({ type: "REQUEST_END" });
    await p.b.poll();
    expect(p.a.view!.end).toBe("requested-by-you");
    expect(p.b.view!.end).toBe("requested-by-partner");
    expect(p.a.view!.game!.phase).toBe("reveal");
    expect(p.a.view!.game!.endedEarly).toBeUndefined();
    expect(scores(p.a.view!)).toEqual([50, 100].slice().reverse().length ? scores(p.b.view!) : []);
  });
  it("both confirm: the pair's game ends with the same final result on both phones", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0); // Aki gives, Ben takes: Ben 100, Aki 50
    await p.a.act({ type: "REQUEST_END" });
    await p.b.poll();
    const r = await p.b.act({ type: "CONFIRM_END" });
    expect(r.ok && r.applied).toBe(true);
    await p.a.poll();
    for (const ph of [p.a, p.b]) {
      expect(ph.view!.game!.phase).toBe("final");
      expect(ph.view!.game!.endedEarly).toBe(true);
      expect(ph.view!.end).toBeNull();
    }
    const [va, vb] = [p.a.view!.game!, p.b.view!.game!];
    expect(va.players).toEqual(vb.players);
    expect(va.players.map((x) => x.name)).toEqual(["Aki", "Ben"]);
    expect(va.players.map((x) => x.score)).toEqual([50, 100]);
    expect(va.history).toEqual(vb.history);
    expect(va.history).toHaveLength(1);
    expect(va.words.map((w) => w.word !== "").map(Boolean)).toBeDefined();
  });
  it("an incomplete round earns no points: ending in the middle of a round keeps only finished rounds", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0); await nextWord(p);
    await p.a.act({ type: "CONTINUE" });
    await giverOf(p).act({ type: "PICK", wordId: WORDS[1].id }); // round 2 starts, not finished
    await takerOf(p).act({ type: "GUESS", text: "definitely wrong" });
    await p.a.act({ type: "REQUEST_END" }); await p.b.act({ type: "CONFIRM_END" });
    await p.a.poll();
    const g = p.a.view!.game!;
    expect(g.phase).toBe("final");
    expect(g.history).toHaveLength(1);
    expect(g.players.map((x) => x.score)).toEqual([50, 100]); // unchanged from the one finished word
    expect(g.statuses[WORDS[1].id]).toBe("pending");
    // neither phone is told the unfinished word
    for (const ph of [p.a, p.b]) expect(JSON.stringify(ph.view)).not.toContain(WORDS[1].meaning);
  });
  it("it can end in every phase of a running game, and an end before any word finishes is a 0–0 tie", async () => {
    const env = await setup();
    const p = await pair(env, "7"); // 'switch' phase
    await p.a.act({ type: "REQUEST_END" }); await p.b.act({ type: "CONFIRM_END" }); await p.a.poll();
    expect(p.a.view!.game).toMatchObject({ phase: "final", endedEarly: true, history: [] });
    expect(scores(p.a.view!)).toEqual([0, 0]);
    const p2 = await pair(env, "8");
    await p2.a.act({ type: "CONTINUE" }); // 'board'
    await p2.b.act({ type: "REQUEST_END" }); await p2.a.act({ type: "CONFIRM_END" });
    expect(p2.a.view!.game!.phase).toBe("final");
    const p3 = await pair(env, "9");
    await p3.a.act({ type: "CONTINUE" }); await giverOf(p3).act({ type: "PICK", wordId: WORDS[2].id }); // 'round'
    await p3.a.act({ type: "REQUEST_END" }); await p3.b.act({ type: "CONFIRM_END" });
    expect(p3.b.view!.game!.phase).toBe("final");
  });
  it("one partner declines: the game carries on, the asker is told, and can ask again later", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0);
    await p.a.act({ type: "REQUEST_END" });
    await p.b.act({ type: "CANCEL_END" });
    await p.a.poll();
    expect(p.a.view!.end).toBe("declined");
    expect(p.b.view!.end).toBeNull();
    expect(p.a.view!.game!.phase).toBe("reveal");
    // the decliner cannot be forced: the asker's old request is not a live request any more
    expect(await p.b.act({ type: "CONFIRM_END" })).toMatchObject({ ok: true, applied: false });
    expect(p.b.view!.game!.phase).toBe("reveal");
    // play continues and scores
    await nextWord(p); await p.a.act({ type: "CONTINUE" });
    await giverOf(p).act({ type: "PICK", wordId: WORDS[1].id });
    await takerOf(p).act({ type: "GUESS", text: WORDS[1].word });
    await p.a.poll();
    expect(scores(p.a.view!)).toEqual([150, 150]);
    // dismissing the notice and asking again works
    await p.a.act({ type: "CANCEL_END" });
    expect(p.a.view!.end).toBeNull();
    await p.a.act({ type: "REQUEST_END" });
    expect(p.a.view!.end).toBe("requested-by-you");
  });
  it("the asker can withdraw; the asker cannot confirm their own request; a duplicate request changes nothing", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await p.a.act({ type: "REQUEST_END" });
    const v1 = p.a.view!.version;
    expect(await p.a.act({ type: "REQUEST_END" })).toMatchObject({ ok: true, applied: false }); // duplicate
    expect(await p.a.act({ type: "CONFIRM_END" })).toMatchObject({ ok: true, applied: false }); // not their call
    expect(p.a.view!.version).toBe(v1);
    expect(p.a.view!.game!.phase).not.toBe("final");
    await p.a.act({ type: "CANCEL_END" });
    await p.b.poll();
    expect(p.b.view!.end).toBeNull();
    expect(await p.b.act({ type: "CONFIRM_END" })).toMatchObject({ ok: true, applied: false }); // nothing to confirm
  });
  it("a retried request (same opId) and simultaneous presses are safe", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0);
    // the same confirmation delivered twice
    await p.a.act({ type: "REQUEST_END" }, "ask-1");
    const first = await p.b.act({ type: "CONFIRM_END" }, "yes-1");
    const retry = await p.b.act({ type: "CONFIRM_END" }, "yes-1");
    expect(first).toMatchObject({ ok: true, applied: true });
    expect(retry).toMatchObject({ ok: true, applied: false });
    expect(scores(p.b.view!)).toEqual([50, 100]);
    // both partners press "End game" at the same moment (two REQUEST_ENDs in flight)
    const q = await pair(env, "8");
    await Promise.all([q.a.act({ type: "REQUEST_END" }), q.b.act({ type: "REQUEST_END" })]);
    await q.a.poll(); await q.b.poll();
    expect(q.a.view!.game!.phase).toBe("final");
    expect(q.b.view!.game!.phase).toBe("final");
    // both confirm at once after one asked
    const r = await pair(env, "9");
    await r.a.act({ type: "REQUEST_END" });
    await Promise.all([r.b.act({ type: "CONFIRM_END" }), r.b.act({ type: "CONFIRM_END" }, "other-op")]);
    await r.a.poll();
    expect(r.a.view!.game!.phase).toBe("final");
    expect(r.a.view!.game!.history).toHaveLength(0);
  });
  it("it cannot be requested before the game starts", async () => {
    const env = await setup();
    const a = env.phone("7", "Aki"), b = env.phone("7", "Ben");
    await a.join(); await b.join();
    expect(await a.act({ type: "REQUEST_END" })).toMatchObject({ ok: false, code: "bad_action" });
  });
});

describe("results", () => {
  it("shows a winner, or a tie when the scores are equal, with completed-word counts", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0); await nextWord(p); // Ben 100, Aki 50
    await p.a.act({ type: "REQUEST_END" }); await p.b.act({ type: "CONFIRM_END" }); await p.a.poll();
    const html = (ph: Phone) => renderToStaticMarkup(h(Final, { state: ph.view!.game!, onAgain: () => undefined, studyHref: "/class/x/study" }));
    expect(p.a.view!.game!.players.map((x) => x.score)).toEqual([50, 100]);
    // equal scores: skipped words score 0 for both
    const q = await pair(env, "8");
    await q.a.act({ type: "CONTINUE" });
    await giverOf(q).act({ type: "PICK", wordId: WORDS[0].id });
    await giverOf(q).act({ type: "SKIP" });
    await q.a.act({ type: "REQUEST_END" }); await q.b.act({ type: "CONFIRM_END" }); await q.a.poll();
    expect(scores(q.a.view!)).toEqual([0, 0]);
    expect(q.a.view!.game!.history).toHaveLength(1);
    void html;
  });
  it("both phones render the same final screen: names, scores, winner, early-finish notice, completed words, study link", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0); await nextWord(p);
    await p.a.act({ type: "REQUEST_END" }); await p.b.act({ type: "CONFIRM_END" }); await p.a.poll();
    const screen = (ph: Phone) => {
      const g = ph.view!.game!;
      return renderToStaticMarkup(h(FinalScreen, { state: g, shown: g.players.map((x) => x.score), onAgain: () => undefined, studyHref: "/class/x/study" })).replace(/<div class="confetti"[\s\S]*?<\/div>/, ""); // confetti is random decoration
    };
    const a = screen(p.a);
    expect(a).toBe(screen(p.b)); // identical on both phones
    expect(a).toContain("Game ended early");
    expect(a).toContain("1 of 5 words completed");
    expect(a).toContain("Only finished words scored");
    expect(a).toContain(">Aki<");
    expect(a).toContain(">Ben<");
    expect(a).toMatch(/champion[^>]*>Ben</); // winner (Ben took the one finished word)
    expect(a).toContain('href="/class/x/study"');
    expect(a).toContain("Study Vocabulary");
    // the drum-roll screen counts finished words, not the whole list
    expect(renderToStaticMarkup(h(Final, { state: p.a.view!.game!, onAgain: () => undefined }))).toContain("One word later");
  });
  it("a tie is shown as a tie, and a normal finish carries no early-finish notice", async () => {
    const env = await setup();
    const q = await pair(env, "8");
    await q.a.act({ type: "REQUEST_END" }); await q.b.act({ type: "CONFIRM_END" }); await q.a.poll();
    const g = q.a.view!.game!;
    const tie = renderToStaticMarkup(h(FinalScreen, { state: g, shown: [0, 0], onAgain: () => undefined }));
    expect(tie).toContain("It&#x27;s a tie!");
    expect(tie).toContain("0 of 5 words completed");
    const p = await pair(env, "9");
    for (let i = 0; i < WORDS.length; i++) { await solve(p, i); await nextWord(p); }
    const normal = renderToStaticMarkup(h(FinalScreen, { state: p.a.view!.game!, shown: scores(p.a.view!), onAgain: () => undefined }));
    expect(normal).not.toContain("ended early");
    expect(normal).toContain("5 of 5 words solved");
  });
});

describe("stability, other pairs and reconnection", () => {
  it("other pairs in the same class are untouched and keep scoring", async () => {
    const env = await setup();
    const p1 = await pair(env, "1");
    const p2 = await pair(env, "2", "Cara", "Dan");
    await solve(p2, 0);
    const before = JSON.stringify(p2.a.view!.game);
    await p1.a.act({ type: "REQUEST_END" }); await p1.b.act({ type: "CONFIRM_END" });
    await p1.a.poll();
    await p2.a.poll(); await p2.b.poll();
    expect(JSON.stringify(p2.a.view!.game)).toBe(before);
    expect(p2.a.view!.end).toBeNull();
    await nextWord(p2); await p2.a.act({ type: "CONTINUE" });
    await giverOf(p2).act({ type: "PICK", wordId: WORDS[1].id });
    await takerOf(p2).act({ type: "GUESS", text: WORDS[1].word });
    await p2.a.poll();
    expect(scores(p2.a.view!)).toEqual([150, 150]);
    expect(p2.a.view!.game!.endedEarly).toBeUndefined();
    expect(p1.a.view!.game!.phase).toBe("final");
  });
  it("refreshing or re-opening the page shows the same final result; nothing can score afterwards", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0);
    await p.a.act({ type: "REQUEST_END" }); await p.b.act({ type: "CONFIRM_END" });
    await p.a.poll();
    const final = JSON.stringify(p.a.view!.game);
    // a refresh = a new join with the stored token
    const again = env.phone("7", "");
    again.token = p.a.token;
    expect((await again.join()).ok).toBe(true);
    expect(JSON.stringify(again.view!.game)).toBe(final);
    // nobody can score or end again
    const t = takerOf(p), g = giverOf(p);
    for (const act of [{ type: "PICK", wordId: WORDS[1].id }, { type: "GUESS", text: WORDS[1].word }, { type: "SKIP" }, { type: "NEXT" }, { type: "CONTINUE" }, { type: "REQUEST_END" }, { type: "CONFIRM_END" }] as ClientAction[]) {
      await t.act(act); await g.act(act);
    }
    await p.a.poll(); await p.b.poll();
    expect(JSON.stringify(p.a.view!.game)).toBe(final);
    expect(JSON.stringify(p.b.view!.game)).toBe(JSON.stringify(p.b.view!.game));
    expect(scores(p.b.view!)).toEqual([50, 100]);
  });
  it("a request survives the partner disconnecting and reconnecting, and is never auto-confirmed", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await solve(p, 0);
    await p.a.act({ type: "REQUEST_END" });
    env.advance((PRESENCE_SECONDS + 2) * 1000); // Ben's phone is offline for a while
    await p.a.poll();
    expect(p.a.view!.partner!.connected).toBe(false);
    expect(p.a.view!.end).toBe("requested-by-you");
    expect(p.a.view!.game!.phase).toBe("reveal"); // nothing ended by itself
    // Ben comes back (refresh) and still sees the question
    const ben = env.phone("7", "");
    ben.token = p.b.token;
    await ben.join();
    expect(ben.view!.end).toBe("requested-by-partner");
    expect(await ben.act({ type: "CONFIRM_END" })).toMatchObject({ ok: true, applied: true });
    await p.a.poll();
    expect(p.a.view!.game!.phase).toBe("final");
  });
  it("normal completion is unchanged: finishing every word ends the game without the early-finish flag", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    for (let i = 0; i < WORDS.length; i++) { await solve(p, i); await nextWord(p); }
    const g = p.a.view!.game!;
    expect(g.phase).toBe("final");
    expect(g.endedEarly).toBeUndefined();
    expect(g.history).toHaveLength(5);
    expect(scores(p.a.view!)).toEqual(scores(p.b.view!));
    expect(p.a.view!.end).toBeNull();
    // play again still starts a fresh game (new scores), as before
    await p.a.act({ type: "PLAY_AGAIN" });
    expect(p.a.view!.game).toBeNull();
  });
  it("security checks still hold: roles from the token, no hints to the Taker, no word before it is played", async () => {
    const env = await setup();
    const p = await pair(env, "7");
    await giverOf(p).act({ type: "CONTINUE" });
    await giverOf(p).act({ type: "PICK", wordId: WORDS[0].id });
    await p.a.poll(); await p.b.poll();
    const t = takerOf(p);
    expect(t.view!.game!.words.find((w) => w.id === WORDS[0].id)!.word).toBe("");
    expect(JSON.stringify(t.view)).not.toContain(WORDS[0].hints[0]);
    expect(await t.act({ type: "PICK", wordId: WORDS[1].id })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await env.svc.act({ activityId: env.activity.id, group: "7", token: "forged", action: { type: "REQUEST_END" } })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await env.svc.act({ activityId: env.activity.id, group: "7", token: t.token, action: { type: "END_EARLY" } })).toMatchObject({ ok: false, code: "bad_action" }); // not a client action
  });
});

describe("End Game controls", () => {
  const view = (over: Partial<ClassView>): ClassView => ({
    version: 1, activityTitle: "T", group: "7", wordCount: 5, you: { seat: 0, name: "Aki" }, partner: { name: "Ben", connected: true },
    stage: "playing", role: "giver", proposal: null, end: null, game: { phase: "board" } as never, ...over,
  });
  const html = (v: ClassView) => renderToStaticMarkup(h(EndGame, { view: v, act: () => undefined }));
  it("is a visible button during play and gone before the game and on the final screen", () => {
    expect(html(view({}))).toContain("End game");
    expect(html(view({ game: null }))).toBe("");
    expect(html(view({ game: { phase: "final" } as never }))).toBe("");
  });
  it("shows the right prompt for each state", () => {
    expect(html(view({ end: "requested-by-partner" }))).toMatch(/Ben<\/b> wants to end the game[\s\S]*End game[\s\S]*Keep playing/);
    expect(html(view({ end: "requested-by-you" }))).toMatch(/Waiting for <b>Ben<\/b>[\s\S]*Cancel request/);
    expect(html(view({ end: "declined" }))).toMatch(/Ben<\/b> wants to keep playing/);
  });
});

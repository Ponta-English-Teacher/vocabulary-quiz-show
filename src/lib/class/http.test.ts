import { describe, expect, it } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { POST as createClass } from "@/app/api/class/route";
import { GET as info } from "@/app/api/class/[activityId]/route";
import { POST as join } from "@/app/api/class/[activityId]/join/route";
import { GET as state } from "@/app/api/class/[activityId]/state/route";
import { POST as action } from "@/app/api/class/[activityId]/action/route";

/** Drives the real route handlers with independent "browsers" — each only has its own token. */
const ctx = (id: string) => ({ params: Promise.resolve({ activityId: id }) });
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function make() {
  const res = await createClass(new Request("http://x/api/class", json({ set: { title: "T", words: SAMPLE_SET.words } })));
  const { id } = await res.json();
  return id as string;
}
class Browser {
  token = "";
  constructor(public id: string, public group: string, public name: string) {}
  async join() {
    const res = await join(new Request("http://x", json({ group: this.group, name: this.name, token: this.token || undefined })), ctx(this.id));
    const body = await res.json();
    if (body.ok) this.token = body.token;
    return { status: res.status, body };
  }
  async poll(extra = "") {
    const res = await state(new Request(`http://x/s?group=${this.group}${extra}`, { headers: { authorization: `Bearer ${this.token}` } }), ctx(this.id));
    return { status: res.status, body: await res.json() };
  }
  async act(a: unknown, opId = Math.random().toString(36)) {
    const res = await action(new Request("http://x", { ...json({ group: this.group, opId, action: a }), headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` } }), ctx(this.id));
    return { status: res.status, body: await res.json() };
  }
}

describe("HTTP API with independent clients", () => {
  it("a full pairing + round trip over the real route handlers", async () => {
    const id = await make();
    expect((await (await info(new Request("http://x"), ctx(id))).json())).toMatchObject({ ok: true, title: "T", wordCount: 10 });
    const a = new Browser(id, "5", "Aki"), b = new Browser(id, "5", "Ben"), c = new Browser(id, "5", "Cleo");
    expect((await a.join()).status).toBe(200);
    expect((await b.join()).status).toBe(200);
    const third = await c.join();
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("full");
    await a.act({ type: "PROPOSE_ROLES", giver: "me" });
    await b.act({ type: "CONFIRM_ROLES" });
    const av = (await a.poll()).body.view, bv = (await b.poll()).body.view;
    expect([av.role, bv.role]).toEqual(["giver", "taker"]);
    await a.act({ type: "CONTINUE" });
    const wordId = SAMPLE_SET.words[0].id;
    expect((await b.act({ type: "PICK", wordId })).status).toBe(403); // Taker can't pick
    await a.act({ type: "PICK", wordId });
    await a.act({ type: "ADJUST_HINTS", delta: 1 });
    const r = await b.poll();
    expect(r.body.view.game.hintsUsed).toBe(1);
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain("umbrella");
    const solved = await b.act({ type: "GUESS", text: "umbrella" });
    expect(solved.body.view.game.lastResult).toMatchObject({ outcome: "solved", takerPoints: 85 });
    // Giver now sees it too, and an unchanged poll is cheap
    const g = await a.poll();
    expect(g.body.view.game.phase).toBe("reveal");
    const again = await a.poll(`&since=${g.body.view.version}`);
    expect(again.body).toMatchObject({ ok: true, unchanged: true });
  });
  it("URL parameters can't grant a role or another seat's data", async () => {
    const id = await make();
    const a = new Browser(id, "5", "Aki"), b = new Browser(id, "5", "Ben");
    await a.join(); await b.join();
    await a.act({ type: "PROPOSE_ROLES", giver: "me" }); await b.act({ type: "CONFIRM_ROLES" });
    await a.act({ type: "CONTINUE" });
    await a.act({ type: "PICK", wordId: SAMPLE_SET.words[3].id }); // borrow
    const sneaky = await b.poll("&role=giver&seat=0&token=" + a.token);
    expect(sneaky.body.view.role).toBe("taker");
    expect(JSON.stringify(sneaky.body).toLowerCase()).not.toContain("borrow");
    // tokens in the query string are not accepted
    const res = await state(new Request(`http://x/s?group=5&token=${a.token}`), ctx(id));
    expect(res.status).toBe(401);
  });
  it("no token or the wrong group is rejected; other groups are unaffected", async () => {
    const id = await make();
    const a = new Browser(id, "1", "Aki"), b = new Browser(id, "11", "Bea");
    await a.join(); await b.join();
    const cross = new Browser(id, "11", "x"); cross.token = a.token;
    expect((await cross.poll()).status).toBe(401);
    expect((await new Browser(id, "1", "x").poll()).status).toBe(401);
    expect((await a.poll()).body.view.partner).toBeNull();
    expect((await b.poll()).body.view.partner).toBeNull();
  });
  it("recovers a session after refresh via the stored token, and validates input", async () => {
    const id = await make();
    const a = new Browser(id, "9", "Aki"); await a.join();
    const refreshed = new Browser(id, "9", ""); refreshed.token = a.token;
    const r = await refreshed.join();
    expect(r.body).toMatchObject({ ok: true, rejoined: true, seat: 0 });
    expect((await new Browser(id, "abc", "A").join()).status).toBe(400);
    expect((await new Browser("nope", "1", "A").join()).status).toBe(404);
    const bad = await join(new Request("http://x", { method: "POST", body: "{oops" }), ctx(id));
    expect(bad.status).toBe(400);
    const huge = await createClass(new Request("http://x", json({ set: { title: "x", words: [] } })));
    expect(huge.status).toBe(400);
  });
});

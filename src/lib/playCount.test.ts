import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabSet } from "@/data/vocab";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createInitialState, gameReducer, getFinalResult, type GameState } from "@/lib/game";
import { clampPlayCount, DEFAULT_PLAY_COUNT, selectWords } from "@/lib/playCount";
import { approveSet, createActivity, createSet, todaysWords } from "@/lib/studio/ops";

const todays = (): VocabSet => {
  const words = SAMPLE_SET.words.map((w, i) => ({ ...w, id: `t${i}`, hints: [`open${i}`, `two${i}`, `three${i}`] }));
  const a = { ...createActivity("Today", "2026-05-01T00:00:00Z"), sets: [createSet(words, "Set 1")] };
  return todaysWords([approveSet(a, a.sets[0].id).activity])!;
};
const SETS: [string, () => VocabSet][] = [["Preset Vocabulary", () => SAMPLE_SET], ["Today's Words", todays]];
const LENGTHS = [1, 3, 5, 7, 10];

describe("clamping and selection", () => {
  it("defaults to 5 and keeps the count a whole number from 1 to the available words", () => {
    expect(DEFAULT_PLAY_COUNT).toBe(5);
    expect(clampPlayCount("", 10)).toBe(5);
    expect(clampPlayCount("abc", 10)).toBe(5);
    expect(clampPlayCount(undefined, 3)).toBe(3);
    expect(clampPlayCount(0, 10)).toBe(1);
    expect(clampPlayCount(-4, 10)).toBe(1);
    expect(clampPlayCount(99, 10)).toBe(10);
    expect(clampPlayCount("7", 10)).toBe(7);
    expect(clampPlayCount(3.9, 10)).toBe(3);
  });
  it("takes the first N words in the set's order, the same every time, without changing the source set", () => {
    const before = JSON.stringify(SAMPLE_SET);
    for (const n of LENGTHS) {
      const a = selectWords(SAMPLE_SET.words, n), b = selectWords(SAMPLE_SET.words, n);
      expect(a.map((w) => w.id)).toEqual(SAMPLE_SET.words.slice(0, n).map((w) => w.id));
      expect(b).toEqual(a);
      expect(new Set(a.map((w) => w.id)).size).toBe(n);
      a.forEach((w, i) => expect(w).toBe(SAMPLE_SET.words[i])); // the very same objects: hints, ja, notes, askKind, pictures intact
    }
    expect(JSON.stringify(SAMPLE_SET)).toBe(before);
    expect(SAMPLE_SET.words).toHaveLength(10);
  });
  it("never returns duplicates even if the source repeats a word", () => {
    const dup = [...SAMPLE_SET.words.slice(0, 3), { ...SAMPLE_SET.words[0], id: "other" }, ...SAMPLE_SET.words.slice(3)];
    const sel = selectWords(dup, 10);
    expect(new Set(sel.map((w) => w.word)).size).toBe(sel.length);
  });
});

describe.each(SETS)("%s — demo mode game lengths", (_n, make) => {
  const set = make();
  it.each(LENGTHS)("%i words: exactly that many rounds, no repeats, alternating roles, final scores", (n) => {
    const words = selectWords(set.words, n);
    let s: GameState = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words });
    const seen: string[] = [], givers: number[] = [];
    for (let i = 0; i < n; i++) {
      s = gameReducer(s, { type: "CONTINUE" });
      givers.push(s.giver);
      const w = words.find((x) => s.statuses[x.id] === "pending")!;
      seen.push(w.id);
      s = gameReducer(s, { type: "PICK", wordId: w.id });
      s = gameReducer(s, { type: "GUESS", text: w.word });
      expect(s.phase).toBe("reveal");
      s = gameReducer(s, { type: "NEXT" });
    }
    expect(s.phase).toBe("final");
    expect(seen).toHaveLength(n);
    expect(new Set(seen).size).toBe(n);
    expect(givers).toEqual(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0 : 1)));
    expect(s.history).toHaveLength(n);
    const total = s.players[0].score + s.players[1].score;
    expect(total).toBe(n * 150);
    expect(getFinalResult(s.players).kind).toMatch(/winner|tie/);
  });
});

describe.each(SETS)("%s — classroom game lengths (two sessions)", (_n, make) => {
  const set = make();
  it.each(LENGTHS)("%i words: both phones see the same words, roles alternate, both reach the same final state, reconnect works", async (n) => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: set.title, words: selectWords(set.words, n) });
    if (!created.ok) throw new Error("create");
    expect(created.activity.words).toHaveLength(n);
    expect(created.activity.words.map((w) => w.id)).toEqual(set.words.slice(0, n).map((w) => w.id));
    const id = created.activity.id;
    const join = async (name: string, token?: string) => { const r = await svc.join({ activityId: id, group: "4", name, token }); if (!r.ok) throw new Error("join"); return r; };
    const A = await join("Aki"), B = await join("Ben");
    const act = (t: string, a: object) => svc.act({ activityId: id, group: "4", token: t, opId: Math.random().toString(36), action: a as never });
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "4", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }); await act(B.token, { type: "CONFIRM_ROLES" });
    const roles: string[] = [], picked: string[] = [];
    for (let i = 0; i < n; i++) {
      const va = await view(A.token), vb = await view(B.token);
      expect(va.game!.words).toHaveLength(n);
      expect(va.game!.phase).toBe(vb.game!.phase); // same state on both phones
      roles.push(va.role!);
      const giver = va.role === "giver" ? A.token : B.token, taker = giver === A.token ? B.token : A.token;
      await act(giver, { type: "CONTINUE" });
      const w = set.words[i];
      await act(giver, { type: "PICK", wordId: w.id });
      picked.push(w.id);
      if (i === Math.floor(n / 2)) await join("Ben", B.token); // reconnect mid-game
      await act(taker, { type: "GUESS", text: w.word });
      await act(taker, { type: "NEXT" });
    }
    const fa = (await view(A.token)).game!, fb = (await view(B.token)).game!;
    expect(fa.phase).toBe("final");
    expect(fb.phase).toBe("final");
    expect(fa.players).toEqual(fb.players);
    expect(fa.players[0].score + fa.players[1].score).toBe(n * 150);
    expect(new Set(picked).size).toBe(n);
    expect(roles).toEqual(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "giver" : "taker")));
  });
  it("reconnecting into a finished game shows the same completion to a rejoining phone", async () => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: "t", words: selectWords(set.words, 1) });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    const A = await svc.join({ activityId: id, group: "4", name: "Aki" }), B = await svc.join({ activityId: id, group: "4", name: "Ben" });
    if (!A.ok || !B.ok) throw new Error("join");
    const act = (t: string, a: object) => svc.act({ activityId: id, group: "4", token: t, opId: Math.random().toString(36), action: a as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }); await act(B.token, { type: "CONFIRM_ROLES" });
    await act(A.token, { type: "CONTINUE" }); await act(A.token, { type: "PICK", wordId: set.words[0].id });
    await act(B.token, { type: "SKIP" }); await act(B.token, { type: "NEXT" });
    const re = await svc.join({ activityId: id, group: "4", name: "Aki", token: A.token });
    expect(re.ok && re.view.game!.phase).toBe("final");
  });
});

describe("existing activities are unchanged", () => {
  it("an activity hosted before this feature (all 10 words) still plays all 10 words", async () => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: SAMPLE_SET.title, words: SAMPLE_SET.words });
    if (!created.ok) throw new Error("create");
    expect(created.activity.words).toHaveLength(10);
    const id = created.activity.id;
    const A = await svc.join({ activityId: id, group: "1", name: "Aki" }), B = await svc.join({ activityId: id, group: "1", name: "Ben" });
    if (!A.ok || !B.ok) throw new Error("join");
    const act = (t: string, a: object) => svc.act({ activityId: id, group: "1", token: t, opId: Math.random().toString(36), action: a as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }); await act(B.token, { type: "CONFIRM_ROLES" });
    const re = await svc.join({ activityId: id, group: "1", name: "Ben", token: B.token });
    expect(re.ok && re.view.game?.words.length).toBe(10);
  });
});

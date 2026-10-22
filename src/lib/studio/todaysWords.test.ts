import { describe, expect, it } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { activityFromSample, approveSet, createActivity, createSet, todaysWords } from "./ops";
import { loadActivities, saveActivity, STORAGE_KEY, type StorageLike } from "./storage";
import type { Activity } from "./types";

const memStorage = (): StorageLike => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};
/** Ten distinctive words, derived from valid sample words so they pass approval. */
const distinctive = (tag: string) =>
  SAMPLE_SET.words.map((w, i) => ({ ...w, id: `${tag}${i}`, word: `${tag}${w.word}`, accept: [`${tag}${w.word}`], hints: w.hints.map((h) => h.replaceAll(w.word, "it")) }));
const approvedActivity = (title: string, tag: string, now: string): Activity => {
  const a = { ...createActivity(title, now), sets: [createSet(distinctive(tag), "Set 1")] };
  const r = approveSet(a, a.sets[0].id);
  if (r.problems.length) throw new Error(r.problems.join("; "));
  return { ...r.activity, updatedAt: now };
};

describe("Today's Words (classroom hosting)", () => {
  it("is not available when nothing is approved — never falls back to the preset", () => {
    expect(todaysWords([])).toBeNull();
    const draft = { ...createActivity("Draft", "2026-01-01T00:00:00Z"), sets: [createSet(distinctive("zz"), "Set 1")] };
    expect(todaysWords([draft])).toBeNull();
  });
  it("an approved set that is no longer complete does not qualify", () => {
    const a = approvedActivity("T", "qq", "2026-01-01T00:00:00Z");
    const short = { ...a, sets: [{ ...a.sets[0], words: a.sets[0].words.slice(0, 9) }] };
    expect(todaysWords([short])).toBeNull();
  });
  it("returns the exact approved words of the newest approved activity, separate from the preset", () => {
    const old = approvedActivity("Old", "old", "2026-01-01T00:00:00Z");
    const fresh = approvedActivity("Fresh", "new", "2026-03-01T00:00:00Z");
    const t = todaysWords([old, fresh])!;
    expect(t.words).toEqual(fresh.sets[0].words);
    expect(t.words).toHaveLength(10);
    expect(t.id).not.toBe(SAMPLE_SET.id);
    expect(t.words.map((w) => w.word)).not.toEqual(SAMPLE_SET.words.map((w) => w.word));
  });
  it("survives a save and reload from browser storage (refresh)", () => {
    const st = memStorage();
    const a = approvedActivity("Fresh", "new", "2026-03-01T00:00:00Z");
    expect(saveActivity(st, a).ok).toBe(true);
    expect(st.getItem(STORAGE_KEY)).toBeTruthy();
    expect(todaysWords(loadActivities(st).activities)!.words.map((w) => w.word)).toEqual(a.sets[0].words.map((w) => w.word));
  });
  it("the sample copy is a separate activity and leaves the preset unchanged", () => {
    const before = JSON.stringify(SAMPLE_SET);
    activityFromSample();
    expect(JSON.stringify(SAMPLE_SET)).toBe(before);
    expect(SAMPLE_SET.words).toHaveLength(10);
  });

  it("hosting Today's Words serves exactly those words to both phones, and hides the answers from the Taker", async () => {
    const a = approvedActivity("Fresh", "new", "2026-03-01T00:00:00Z");
    const t = todaysWords([a])!;
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now);
    const created = await svc.createActivity({ title: t.title, words: t.words });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    expect(created.activity.words.map((w) => w.word)).toEqual(t.words.map((w) => w.word));
    const p1 = await svc.join({ activityId: id, group: "3", name: "Aki" });
    const p2 = await svc.join({ activityId: id, group: "3", name: "Ben" });
    if (!p1.ok || !p2.ok) throw new Error("join");
    await svc.act({ activityId: id, group: "3", token: p1.token, opId: "1", action: { type: "PROPOSE_ROLES", giver: "me" } });
    await svc.act({ activityId: id, group: "3", token: p2.token, opId: "2", action: { type: "CONFIRM_ROLES" } });
    await svc.act({ activityId: id, group: "3", token: p1.token, opId: "2b", action: { type: "CONTINUE" } });
    await svc.act({ activityId: id, group: "3", token: p1.token, opId: "3", action: { type: "PICK", wordId: t.words[4].id } });
    const g = await svc.getView({ activityId: id, group: "3", token: p1.token });
    const k = await svc.getView({ activityId: id, group: "3", token: p2.token });
    if (!g.ok || !k.ok || g.unchanged || k.unchanged) throw new Error("view");
    const ours = new Set(t.words.map((w) => w.word));
    expect(g.view.game!.words.every((w) => !w.word || ours.has(w.word) || w.word === "")).toBe(true);
    const giverWord = g.view.game!.words.find((w) => w.id === g.view.game!.currentWordId)!;
    expect(giverWord.word).toBe(t.words[4].word);
    // Taker sees no answer
    const takerJson = JSON.stringify(k.view);
    for (const w of t.words) expect(takerJson).not.toContain(w.word);
    // a refreshed/reconnected phone gets the same activity
    const again = await svc.join({ activityId: id, group: "3", name: "Aki", token: p1.token });
    expect(again.ok).toBe(true);
    const g2 = await svc.getView({ activityId: id, group: "3", token: p1.token });
    expect(g2.ok && !("unchanged" in g2 && g2.unchanged) ? (g2 as { view: typeof g.view }).view.game!.words.map((w) => w.id) : null).toEqual(g.view.game!.words.map((w) => w.id));
  });
});

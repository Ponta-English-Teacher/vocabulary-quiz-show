import { describe, expect, it } from "vitest";
import { activityFromSample, createActivity, createSet, updateWord } from "./ops";
import { deleteActivity, duplicateActivity, loadActivities, parseActivity, saveActivity, STORAGE_KEY, type StorageLike } from "./storage";

function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

describe("saving and reopening", () => {
  it("round-trips an activity exactly (words, hints, accepted answers, lock state, chat)", () => {
    const store = memory();
    const a = { ...activityFromSample(), messages: [{ role: "teacher" as const, text: "hi" }, { role: "ai" as const, text: "hello" }] };
    a.sets[0].lockedIds = [a.sets[0].words[1].id];
    a.brief = { ...a.brief, topic: "Mixed", level: "B1", numSets: 2 };
    expect(saveActivity(store, a).ok).toBe(true);
    const { activities, skipped } = loadActivities(store);
    expect(skipped).toBe(0);
    expect(activities).toHaveLength(1);
    expect(activities[0].sets[0].words).toEqual(a.sets[0].words);
    expect(activities[0].sets[0].lockedIds).toEqual(a.sets[0].lockedIds);
    expect(activities[0].messages).toEqual(a.messages);
    expect(activities[0].brief).toEqual(a.brief);
    expect(activities[0].sets[0].status).toBe("approved");
  });
  it("saving revisions replaces the same activity instead of adding a new one", () => {
    const store = memory();
    const a = activityFromSample();
    saveActivity(store, a);
    const edited = updateWord(a, a.sets[0].id, a.sets[0].words[0].id, { meaning: "revised meaning" });
    saveActivity(store, edited);
    const { activities } = loadActivities(store);
    expect(activities).toHaveLength(1);
    expect(activities[0].sets[0].words[0].meaning).toBe("revised meaning");
    expect(activities[0].sets[0].status).toBe("draft");
  });
  it("orders most recently saved first", () => {
    const store = memory();
    const a = createActivity("A"), b = createActivity("B");
    saveActivity(store, a);
    saveActivity(store, b);
    saveActivity(store, a);
    expect(loadActivities(store).activities.map((x) => x.title)).toEqual(["A", "B"]);
  });
});

describe("duplicate and delete", () => {
  it("duplicates with new ids for activity, sets and words, keeping content and locks", () => {
    const store = memory();
    const a = activityFromSample();
    a.sets[0].lockedIds = [a.sets[0].words[0].id];
    saveActivity(store, a);
    const res = duplicateActivity(store, a.id);
    expect(res.ok).toBe(true);
    const { activities } = loadActivities(store);
    expect(activities).toHaveLength(2);
    const copy = activities.find((x) => x.id === res.copyId)!;
    expect(copy.title).toMatch(/^Copy of /);
    expect(copy.id).not.toBe(a.id);
    expect(copy.sets[0].id).not.toBe(a.sets[0].id);
    expect(copy.sets[0].words.map((w) => w.word)).toEqual(a.sets[0].words.map((w) => w.word));
    expect(copy.sets[0].words[0].id).not.toBe(a.sets[0].words[0].id);
    expect(copy.sets[0].lockedIds).toEqual([copy.sets[0].words[0].id]);
  });
  it("deletes only the chosen activity", () => {
    const store = memory();
    const a = createActivity("keep"), b = createActivity("drop");
    saveActivity(store, a); saveActivity(store, b);
    deleteActivity(store, b.id);
    expect(loadActivities(store).activities.map((x) => x.title)).toEqual(["keep"]);
  });
});

describe("resilience", () => {
  it("survives corrupt JSON and bad entries", () => {
    expect(loadActivities(memory({ [STORAGE_KEY]: "{not json" }))).toEqual({ activities: [], skipped: 1 });
    const good = activityFromSample();
    const store = memory({ [STORAGE_KEY]: JSON.stringify([good, { id: 5 }, null]) });
    const res = loadActivities(store);
    expect(res.activities).toHaveLength(1);
    expect(res.skipped).toBe(2);
  });
  it("reports failure instead of throwing when storage is unavailable or full", () => {
    expect(saveActivity(null, createActivity()).ok).toBe(false);
    const full: StorageLike = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const res = saveActivity(full, createActivity());
    expect(res.ok).toBe(false);
    expect(loadActivities(null).activities).toEqual([]);
  });
  it("drops unreadable words inside a saved set instead of crashing", () => {
    const set = createSet([], "S");
    const a = parseActivity({ ...createActivity("X"), sets: [{ ...set, words: [{ word: "ok" }, null] }] });
    expect(a?.sets[0].words).toEqual([]);
  });
});

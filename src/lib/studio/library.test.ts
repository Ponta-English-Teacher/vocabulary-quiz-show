import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { HostClass } from "@/components/class/HostClass";
import { StudioHome } from "@/components/studio/StudioHome";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { selectWords } from "@/lib/playCount";
import { deleteLibraryList, libraryLists } from "./library";
import { addSet, approveSet, createActivity, renameActivity, renameSet, reopenSet, updateWord } from "./ops";
import { loadActivities, saveActivity, STORAGE_KEY, type StorageLike } from "./storage";
import type { Activity } from "./types";

const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };
const mk = (n: string, i: number): VocabWord => ({
  id: `w-${n}-${i}`, word: n, accept: [], partOfSpeech: "noun", category: "Kitchen", cefr: "A2", meaning: `the meaning of ${n}`, example: `We used the ${n}.`,
  hints: [`You see it on a busy morning number ${i}.`, "People keep it close to the basin or the oven.", "It is used often when guests come."], ja: [`日本語${n}`],
});
const words = (names: string[]) => names.map(mk);
/** An approved activity with one set per word list. */
function activity(title: string, lists: string[][], at: string, approved = true): Activity {
  let a = createActivity(title, at);
  for (const l of lists) a = addSet(a, words(l), { requested: l.length });
  if (approved) for (const s of a.sets) a = approveSet(a, s.id).activity;
  return { ...a, updatedAt: at };
}
const seed = () => {
  const s = memory();
  const a = activity("Kitchen", [["colander", "whisk", "ladle"], ["tongs"]], "2026-04-01T00:00:00.000Z");
  const b = activity("Bathroom", [["towel", "soap", "mirror", "shower", "brush", "comb", "sink", "tub", "tap", "drain"]], "2026-04-02T00:00:00.000Z");
  const c = activity("Draft only", [["fork", "knife"]], "2026-04-03T00:00:00.000Z", false);
  // saved directly, so updatedAt stays as given
  s.setItem(STORAGE_KEY, JSON.stringify([c, b, a]));
  return { s, a, b, c };
};
const KEY = STORAGE_KEY;

describe("the Vocabulary Library lists every approved set", () => {
  it("shows all approved, complete sets from all activities as independent lists, newest activity first; drafts are excluded", () => {
    const { s } = seed();
    const lists = libraryLists(loadActivities(s).activities);
    expect(lists.map((l) => `${l.title}|${l.count}`)).toEqual(["Bathroom — Set 1|10", "Kitchen — Set 1|3", "Kitchen — Set 2|1"]);
    expect(lists[0].words.map((w) => w.word)).toEqual(["towel", "soap", "mirror", "shower", "brush", "comb", "sink", "tub", "tap", "drain"]);
    expect(new Set(lists.map((l) => l.key)).size).toBe(3);
  });
  it("short lists (1 word) and 10-word lists both appear with their exact words", () => {
    const { s } = seed();
    const lists = libraryLists(loadActivities(s).activities);
    expect(lists.find((l) => l.count === 1)!.words.map((w) => w.word)).toEqual(["tongs"]);
    expect(Math.max(...lists.map((l) => l.count))).toBe(10);
  });
  it("saving a NEW list never replaces an older one just because it is newer", () => {
    const { s } = seed();
    const before = libraryLists(loadActivities(s).activities);
    saveActivity(s, activity("Garden", [["spade", "rake"]], "2026-05-01T00:00:00.000Z"));
    const after = libraryLists(loadActivities(s).activities);
    expect(after).toHaveLength(before.length + 1);
    for (const l of before) expect(after.find((x) => x.key === l.key)!.words).toEqual(l.words);
    expect(after[0].title).toMatch(/Garden/);
  });
  it("lists are named: the set name is part of the title, renaming changes only the title", () => {
    const { s, a } = seed();
    const renamed = renameSet(a, a.sets[0].id, "Utensils for pasta");
    saveActivity(s, renamed);
    const lists = libraryLists(loadActivities(s).activities);
    expect(lists.map((l) => l.title)).toContain("Kitchen — Utensils for pasta");
    const l = lists.find((x) => x.setId === a.sets[0].id)!;
    expect(l.words.map((w) => [w.id, w.word])).toEqual(a.sets[0].words.map((w) => [w.id, w.word])); // words untouched
    expect(loadActivities(s).activities.find((x) => x.id === a.id)!.sets[0].status).toBe("approved"); // still approved
    expect(renameActivity(a, "Renamed kitchen").title).toBe("Renamed kitchen");
  });
  it("the preset vocabulary is still offered on the hosting screen", () => {
    const html = renderToStaticMarkup(h(HostClass));
    expect(html).toContain("Preset Vocabulary");
    expect(html).toContain(SAMPLE_SET.title);
    expect(html).not.toMatch(/Today&#x27;s Words — Not available/);
  });
});

describe("selecting a list for hosting", () => {
  it("any list can be chosen, not only the most recent; hosting uses its exact words in order, first N for a short game", async () => {
    const { s } = seed();
    const lists = libraryLists(loadActivities(s).activities);
    const older = lists.find((l) => l.title === "Kitchen — Set 1")!; // not the newest
    const cls = new ClassService(new MemoryKV());
    const r = await cls.createActivity({ title: older.title, words: selectWords(older.words, 2) });
    if (!r.ok) throw new Error();
    expect(r.activity.words.map((w) => w.word)).toEqual(["colander", "whisk"]);
    const full = await cls.createActivity({ title: older.title, words: selectWords(older.words, 3) });
    expect(full.ok && full.activity.words.map((w) => w.word)).toEqual(["colander", "whisk", "ladle"]);
  });
  it("a running class keeps its words even if the source list is edited, renamed or deleted afterwards", async () => {
    const { s, a } = seed();
    const lists = libraryLists(loadActivities(s).activities);
    const target = lists.find((l) => l.title === "Kitchen — Set 1")!;
    const kv = new MemoryKV();
    const cls = new ClassService(kv);
    const r = await cls.createActivity({ title: target.title, words: target.words });
    if (!r.ok) throw new Error();
    const snapshot = JSON.stringify(r.activity.words);
    // the teacher edits the list's first word, renames it, then deletes it
    let edited = reopenSet(a, target.setId);
    edited = updateWord(edited, target.setId, target.words[0].id, { meaning: "CHANGED AFTER HOSTING", word: "sieve" });
    edited = renameSet(edited, target.setId, "Renamed");
    saveActivity(s, edited);
    deleteLibraryList(s, target.key);
    const stored = JSON.parse((await kv.get(`vqs:act:${r.activity.id}`))!) as { words: VocabWord[] };
    expect(JSON.stringify(stored.words)).toBe(snapshot);
    expect(stored.words[0].word).toBe("colander");
  });
  it("hosting a list changes nothing in the library", async () => {
    const { s } = seed();
    const before = JSON.stringify(libraryLists(loadActivities(s).activities));
    const l = libraryLists(loadActivities(s).activities)[0];
    await new ClassService(new MemoryKV()).createActivity({ title: l.title, words: l.words });
    expect(JSON.stringify(libraryLists(loadActivities(s).activities))).toBe(before);
  });
});

describe("editing and deleting one list leaves the others alone", () => {
  it("editing one list's word changes only that list", () => {
    const { s, a } = seed();
    const target = libraryLists(loadActivities(s).activities).find((l) => l.title === "Kitchen — Set 1")!;
    const others = libraryLists(loadActivities(s).activities).filter((l) => l.key !== target.key);
    const reopened = reopenSet(a, target.setId); // explicit reopen, as in the Studio
    const edited = approveSet(updateWord(reopened, target.setId, target.words[1].id, { meaning: "a new meaning for whisk" }), target.setId).activity;
    saveActivity(s, edited);
    const after = libraryLists(loadActivities(s).activities);
    expect(after.find((l) => l.key === target.key)!.words[1].meaning).toBe("a new meaning for whisk");
    for (const o of others) expect(after.find((l) => l.key === o.key)!.words).toEqual(o.words);
  });
  it("deleting a list removes exactly that set: sibling sets in the same activity and other activities stay intact", () => {
    const { s } = seed();
    const lists = libraryLists(loadActivities(s).activities);
    const target = lists.find((l) => l.title === "Kitchen — Set 1")!;
    const r = deleteLibraryList(s, target.key);
    expect(r).toEqual({ ok: true, title: "Kitchen — Set 1" });
    const after = libraryLists(loadActivities(s).activities);
    expect(after.map((l) => l.key)).toEqual(lists.filter((l) => l.key !== target.key).map((l) => l.key));
    for (const l of after) expect(l.words).toEqual(lists.find((x) => x.key === l.key)!.words);
    // the activity itself is still saved (the draft-only activity too)
    expect(loadActivities(s).activities.map((x) => x.title).sort()).toEqual(["Bathroom", "Draft only", "Kitchen"]);
    expect(deleteLibraryList(s, target.key)).toMatchObject({ ok: false }); // already gone
    expect(deleteLibraryList(s, "nope:nope")).toMatchObject({ ok: false });
  });
  it("deletion needs confirmation: the library offers Edit and Delete buttons, and the confirm step is the shared ConfirmButton (nothing is deleted on render)", () => {
    const { s } = seed();
    const lists = libraryLists(loadActivities(s).activities);
    let deleted = 0;
    const html = renderToStaticMarkup(h(StudioHome, {
      activities: loadActivities(s).activities, library: lists, onEditList: () => undefined, onDeleteList: () => { deleted++; },
      skipped: 0, storageOk: true, message: null, onDismissMessage: () => undefined, onNew: () => undefined, onOpen: () => undefined,
      onDuplicate: () => undefined, onDelete: () => undefined, onPlay: () => undefined, onCopySample: () => undefined,
    }));
    expect(html).toContain("Vocabulary Library");
    expect(html).toContain("Bathroom — Set 1");
    expect(html).toContain("10 words");
    expect(html).toContain("1 word ·");
    expect(html).not.toContain("Share study page"); // students study from the class link; no manual publishing
    expect(html).not.toContain("This can&#x27;t be undone. Your other lists"); // confirmation text appears only after pressing Delete
    expect(deleted).toBe(0);
  });
});

describe("existing data stays accessible", () => {
  it("older saved activities (no list names, no extra fields) appear in the library unchanged and nothing is migrated", () => {
    const s = memory();
    const old = activity("Old activity", [["ladder", "bucket"]], "2025-01-01T00:00:00.000Z");
    const raw = JSON.stringify([old]);
    s.setItem(KEY, raw);
    const lists = libraryLists(loadActivities(s).activities);
    expect(lists.map((l) => l.title)).toEqual(["Old activity — Set 1"]);
    expect(s.getItem(KEY)).toBe(raw); // reading the library wrote nothing
    expect(lists[0].words.map((w) => w.word)).toEqual(["ladder", "bucket"]);
  });
  it("an approved set that is missing a word is still LISTED (so it can be fixed, shared or deleted) but is not offered for hosting", () => {
    const s = memory();
    const a = activity("Broken", [["ladder", "bucket"]], "2026-01-01T00:00:00.000Z");
    a.sets[0].missing = [{ word: "rope", reason: "no item", index: 2 }];
    s.setItem(KEY, JSON.stringify([a]));
    const l = libraryLists(loadActivities(s).activities);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ ready: false, count: 2 });
    expect(l[0].problems.join(" ")).toMatch(/rope/);
  });
  it("an approved set whose words now fail a validation rule is never hidden: it stays listed and hostable, with a note", () => {
    const s = memory();
    const a = activity("Older set", [["ladder", "bucket"]], "2026-01-01T00:00:00.000Z");
    a.sets[0].words[0].hints[1] = "A ladder is something you climb."; // a hint that gives the word away
    s.setItem(KEY, JSON.stringify([a]));
    const l = libraryLists(loadActivities(s).activities);
    expect(l.map((x) => x.title)).toEqual(["Older set — Set 1"]);
    expect(l[0].ready).toBe(true);
    expect(l[0].problems.length).toBeGreaterThan(0);
  });
});

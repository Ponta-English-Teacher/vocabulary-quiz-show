import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, buildBackup, backupFilename } from "./backup";
import { BANK_KEY } from "./cqsBank";
import { STORAGE_KEY, type StorageLike } from "./storage";

const mem = (init: Record<string, string> = {}) => {
  const data = { ...init };
  const calls: string[] = [];
  const s: StorageLike & { data: Record<string, string>; calls: string[] } = {
    data,
    calls,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { calls.push(`set:${k}`); data[k] = v; },
  };
  return s;
};
const q = (id: string, answer: string) => ({ id, cefrLevel: "A2", categoryId: "everyday", categoryName: "Everyday", prompt: "What is this?", chunks: ["clue number one is here", "clue number two is here", "clue number three is here", "clue number four is here"], choices: [answer, "x", "y", "z"], correctIndex: 0, answer, status: "approved" });
const bank = { v: 1, fileName: "b.json", exportedAt: "2026-11-12", savedAt: "2026-11-13", questions: [q("a", "kettle"), q("b", "bones")], origin: "sync", etag: '"e1"' };
const acts = [{ id: "act1", sets: [{ id: "s1", words: [{ id: "w1" }, { id: "w2" }] }] }];

describe("Export Backup", () => {
  it("copies the bank, its report and the activities, and never writes", () => {
    const s = mem({ [BANK_KEY]: JSON.stringify(bank), [STORAGE_KEY]: JSON.stringify(acts), "vqs.teacher.passcode": "secret-pass" });
    const before = JSON.stringify(s.data);
    const b = buildBackup(s, new Date("2026-11-14T10:00:00Z"));
    expect(b.format).toBe(BACKUP_FORMAT);
    expect(b.bank).toEqual(bank);
    expect(b.activities).toEqual(acts);
    expect(b.summary).toMatchObject({ bankQuestions: 2, activities: 1, sets: 1, words: 2 });
    expect((b.bankReport as { items: unknown[] }).items).toHaveLength(2);
    expect(s.calls).toEqual([]);
    expect(JSON.stringify(s.data)).toBe(before);
  });
  it("never includes the teacher passcode", () => {
    const s = mem({ [BANK_KEY]: JSON.stringify(bank), "vqs.teacher.passcode": "secret-pass" });
    expect(JSON.stringify(buildBackup(s))).not.toContain("secret-pass");
  });
  it("works with nothing saved or with no storage", () => {
    for (const st of [mem(), null]) {
      const b = buildBackup(st);
      expect(b.bank).toBeNull();
      expect(b.activities).toBeNull();
      expect(b.summary.bankQuestions).toBe(0);
    }
  });
  it("keeps the original text of damaged data instead of dropping it", () => {
    const b = buildBackup(mem({ [STORAGE_KEY]: "{not json" }));
    expect(b.activities).toEqual({ unreadableText: "{not json" });
  });
  it("survives storage that throws on read", () => {
    const bad: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    expect(() => buildBackup(bad)).not.toThrow();
  });
  it("names the file with the date", () => {
    expect(backupFilename(new Date(2026, 10, 14, 9, 5))).toBe("vqs-backup-2026-11-14-0905.json");
  });
});

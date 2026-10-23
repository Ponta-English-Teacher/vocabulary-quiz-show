import type { VocabWord } from "@/data/vocab";
import { approvalProblems, removeSet } from "./ops";
import { loadActivities, saveActivity, type StorageLike } from "./storage";
import type { Activity } from "./types";

/**
 * The Vocabulary Library is a VIEW over the teacher's saved activities: every approved, complete set is one list.
 * Nothing is copied or migrated, so existing activities and approved sets are already in it, and changing or deleting one
 * list can only touch that one set.
 */
export interface LibraryList {
  /** Stable identity of a list: "<activityId>:<setId>". Never derived from recency. */
  key: string;
  activityId: string;
  setId: string;
  /** "<activity title> — <set name>" */
  title: string;
  count: number;
  words: VocabWord[];
  /** False when the set is still missing words: it is shown (so it can be fixed or deleted) but cannot be hosted. */
  ready: boolean;
  /** Words with no Japanese meaning yet (shown on the student Study Page as "not added yet"). */
  missingJapanese: string[];
  /** Anything that needs the teacher's attention. Never hides a list. */
  problems: string[];
}

export const listKey = (activityId: string, setId: string) => `${activityId}:${setId}`;

/** Every approved set of every saved activity, newest-created activity first, so editing or deleting never reorders the others (sets keep their order). */
export function libraryLists(activities: Activity[]): LibraryList[] {
  return [...activities]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((a) =>
      a.sets
        .filter((s) => s.status === "approved")
        .map((s) => ({
          key: listKey(a.id, s.id), activityId: a.id, setId: s.id, title: `${a.title} — ${s.title.trim() || "Set"}`, count: s.words.length, words: s.words,
          ready: !s.missing?.length && s.words.length > 0, problems: approvalProblems(s),
          missingJapanese: s.words.filter((w) => ![...(w.ja ?? []), ...(w.studyJa ?? [])].some((j) => j.trim())).map((w) => w.word),
        })),
    );
}

/** Delete exactly one list (set). The activity and its other sets are left as they are. */
export function deleteLibraryList(storage: StorageLike | null, key: string): { ok: true; title: string } | { ok: false; error: string } {
  const { activities } = loadActivities(storage);
  const found = libraryLists(activities).find((l) => l.key === key);
  const activity = found && activities.find((a) => a.id === found.activityId);
  if (!found || !activity) return { ok: false, error: "That list no longer exists." };
  const res = saveActivity(storage, removeSet(activity, found.setId));
  return res.ok ? { ok: true, title: found.title } : { ok: false, error: res.error };
}

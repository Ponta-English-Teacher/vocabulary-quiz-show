import type { Activity, ChatMessage, StudioSet } from "./types";
import { EMPTY_BRIEF } from "./types";
import { newId } from "./ids";
import { coerceWord } from "./validation";
import { normalizeCefr } from "./validation";
import type { Brief } from "./types";
import type { VocabWord } from "@/data/vocab";

/**
 * Browser-local persistence. Data lives ONLY in this browser's localStorage:
 * it does not sync between devices and is not a permanent cloud backup.
 */
export const STORAGE_KEY = "vqs.activities.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getBrowserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    s.getItem(STORAGE_KEY); // may throw when storage is blocked
    return s;
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, d = "") => (typeof v === "string" ? v : d);

function parseBrief(raw: unknown): Brief {
  if (!isObj(raw)) return { ...EMPTY_BRIEF };
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const n = typeof raw.numSets === "number" ? Math.round(raw.numSets) : 1;
  return {
    topic: text(raw.topic),
    level: normalizeCefr(raw.level),
    objectives: strs(raw.objectives),
    learnerFocus: text(raw.learnerFocus),
    numSets: Math.min(5, Math.max(1, n)),
    avoid: strs(raw.avoid),
    balance: text(raw.balance),
    approvalPending: raw.approvalPending === true,
    wordType: text(raw.wordType),
    candidates: strs(raw.candidates),
    candidateBands: (() => {
      const b = isObj(raw.candidateBands) ? raw.candidateBands : {};
      return { familiar: strs(b.familiar), moderate: strs(b.moderate), unfamiliar: strs(b.unfamiliar) };
    })(),
    pinnedCandidates: strs(raw.pinnedCandidates),
    removedCandidates: strs(raw.removedCandidates),
    approvedWords: strs(raw.approvedWords),
  };
}

/** Rebuild a saved activity defensively; returns null if it is unusable. Content rules are NOT applied (teacher drafts may be incomplete). */
export function parseActivity(raw: unknown): Activity | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !Array.isArray(raw.sets)) return null;
  const sets: StudioSet[] = [];
  for (const s of raw.sets) {
    if (!isObj(s) || typeof s.id !== "string" || !Array.isArray(s.words)) return null;
    const words: VocabWord[] = [];
    for (const w of s.words) {
      const id = isObj(w) && typeof w.id === "string" ? w.id : undefined;
      const c = coerceWord(w, { id });
      if ("word" in c) words.push(c.word);
    }
    sets.push({
      id: s.id,
      title: text(s.title, "Set"),
      status: s.status === "approved" ? "approved" : "draft",
      words,
      lockedIds: Array.isArray(s.lockedIds) ? s.lockedIds.filter((x): x is string => typeof x === "string") : [],
    });
  }
  const messages: ChatMessage[] = Array.isArray(raw.messages)
    ? raw.messages.flatMap((m) =>
        isObj(m) && (m.role === "teacher" || m.role === "ai") && typeof m.text === "string"
          ? [{ role: m.role, text: m.text } as ChatMessage]
          : [],
      )
    : [];
  const now = new Date().toISOString();
  return {
    id: raw.id,
    title: text(raw.title, "Untitled activity"),
    brief: parseBrief(raw.brief),
    messages,
    sets,
    createdAt: text(raw.createdAt, now),
    updatedAt: text(raw.updatedAt, now),
    version: 1,
  };
}

export interface LoadResult {
  activities: Activity[];
  /** Number of stored entries that were unreadable and ignored. */
  skipped: number;
}

export function loadActivities(storage: StorageLike | null): LoadResult {
  if (!storage) return { activities: [], skipped: 0 };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { activities: [], skipped: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { activities: [], skipped: 1 };
    const activities = parsed.map(parseActivity).filter((a): a is Activity => a !== null);
    return { activities, skipped: parsed.length - activities.length };
  } catch {
    return { activities: [], skipped: 1 };
  }
}

export type WriteResult = { ok: true; activities: Activity[] } | { ok: false; error: string };

function write(storage: StorageLike | null, activities: Activity[]): WriteResult {
  if (!storage) return { ok: false, error: "This browser is blocking local storage, so nothing can be saved." };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(activities));
    return { ok: true, activities };
  } catch {
    return { ok: false, error: "Saving failed (browser storage may be full or disabled)." };
  }
}

/** Insert or replace by id. Newest-updated first. */
export function saveActivity(storage: StorageLike | null, activity: Activity): WriteResult {
  const { activities } = loadActivities(storage);
  const saved = { ...activity, updatedAt: new Date().toISOString() };
  const rest = activities.filter((a) => a.id !== activity.id);
  return write(storage, [saved, ...rest]);
}

export function duplicateActivity(storage: StorageLike | null, id: string): WriteResult & { copyId?: string } {
  const { activities } = loadActivities(storage);
  const src = activities.find((a) => a.id === id);
  if (!src) return { ok: false, error: "Activity not found." };
  const now = new Date().toISOString();
  const copy: Activity = {
    ...src,
    id: newId("a"),
    title: `Copy of ${src.title}`.slice(0, 80),
    createdAt: now,
    updatedAt: now,
    sets: src.sets.map((s) => {
      const idMap = new Map(s.words.map((w) => [w.id, newId("w")]));
      return {
        ...s,
        id: newId("s"),
        words: s.words.map((w) => ({ ...w, id: idMap.get(w.id)! })),
        lockedIds: s.lockedIds.map((x) => idMap.get(x)).filter((x): x is string => !!x),
      };
    }),
  };
  const res = write(storage, [copy, ...activities]);
  return res.ok ? { ...res, copyId: copy.id } : res;
}

export function deleteActivity(storage: StorageLike | null, id: string): WriteResult {
  const { activities } = loadActivities(storage);
  return write(storage, activities.filter((a) => a.id !== id));
}

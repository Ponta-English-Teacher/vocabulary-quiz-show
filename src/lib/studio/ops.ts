import { SAMPLE_SET, type VocabSet, type VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { newId } from "./ids";
import { EMPTY_BRIEF, SET_SIZE, type Activity, type Brief, type StudioSet } from "./types";
import { hasErrors, validateWord } from "./validation";

/**
 * Pure editing operations on an Activity. Every function returns a NEW activity and
 * leaves untouched words/sets as the very same objects — so changing one item can
 * never overwrite another (this is unit-tested).
 */

const nowIso = () => new Date().toISOString();

export function createActivity(title = "Untitled activity", now = nowIso()): Activity {
  return {
    id: newId("a"),
    title,
    brief: { ...EMPTY_BRIEF },
    messages: [],
    sets: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export function createSet(words: VocabWord[], title: string): StudioSet {
  return { id: newId("s"), title, status: "draft", words, lockedIds: [] };
}

/** Copy the built-in sample into an editable activity (fresh ids, marked approved). */
export function activityFromSample(now = nowIso()): Activity {
  const a = createActivity("Sample set — Mixed (copy)", now);
  const words = SAMPLE_SET.words.map((w) => ({ ...w, id: newId("w") }));
  return { ...a, sets: [{ ...createSet(words, "Set 1"), status: "approved" }] };
}

const touch = (a: Activity, now = nowIso()): Activity => ({ ...a, updatedAt: now });

function mapSet(a: Activity, setId: string, fn: (s: StudioSet) => StudioSet, now?: string): Activity {
  if (!a.sets.some((s) => s.id === setId)) return a;
  return touch({ ...a, sets: a.sets.map((s) => (s.id === setId ? fn(s) : s)) }, now);
}

/** Any content change sends an approved set back to draft: it needs re-approval. */
const edited = (s: StudioSet, words: VocabWord[], lockedIds = s.lockedIds): StudioSet => ({
  ...s,
  words,
  lockedIds,
  status: "draft",
});

export function setBrief(a: Activity, brief: Brief): Activity {
  return touch({ ...a, brief });
}

export function renameActivity(a: Activity, title: string): Activity {
  return touch({ ...a, title: title.trim().slice(0, 80) || "Untitled activity" });
}

export function updateWord(
  a: Activity,
  setId: string,
  wordId: string,
  patch: Partial<Omit<VocabWord, "id">>,
  now?: string,
): Activity {
  return mapSet(a, setId, (s) => edited(s, s.words.map((w) => (w.id === wordId ? { ...w, ...patch } : w))), now);
}

export function setHints(a: Activity, setId: string, wordId: string, hints: string[]): Activity {
  return updateWord(a, setId, wordId, { hints });
}

/** All words in the activity (for "don't repeat these" requests). */
export function allTargetForms(a: Activity): string[] {
  return a.sets.flatMap((s) => s.words.map((w) => w.word));
}

/** Replace exactly one word in place. Refuses duplicates of other words in the set. */
export function replaceWord(
  a: Activity,
  setId: string,
  wordId: string,
  next: VocabWord,
): { activity: Activity; error?: string } {
  const set = a.sets.find((s) => s.id === setId);
  if (!set || !set.words.some((w) => w.id === wordId)) return { activity: a, error: "That word no longer exists." };
  const n = normalize(next.word);
  if (set.words.some((w) => w.id !== wordId && normalize(w.word) === n)) {
    return { activity: a, error: `“${next.word}” is already in this set.` };
  }
  const fresh: VocabWord = { ...next, id: newId("w") };
  return {
    activity: mapSet(a, setId, (s) =>
      edited(
        s,
        s.words.map((w) => (w.id === wordId ? fresh : w)),
        s.lockedIds.filter((id) => id !== wordId),
      ),
    ),
  };
}

export function toggleLock(a: Activity, setId: string, wordId: string): Activity {
  return mapSet(a, setId, (s) => ({
    ...s,
    lockedIds: s.lockedIds.includes(wordId) ? s.lockedIds.filter((id) => id !== wordId) : [...s.lockedIds, wordId],
  }));
}

/**
 * Whole-set regeneration: locked words stay exactly where they are; every other
 * slot takes the next fresh, non-duplicate word. If the AI supplied too few, the
 * old word simply stays (the set always keeps its size).
 */
export function regenerateSet(
  a: Activity,
  setId: string,
  fresh: VocabWord[],
): { activity: Activity; replaced: number } {
  let replaced = 0;
  const activity = mapSet(a, setId, (s) => {
    const used = new Set(s.words.filter((w) => s.lockedIds.includes(w.id)).map((w) => normalize(w.word)));
    const queue = fresh.filter((f) => !used.has(normalize(f.word)));
    const words = s.words.map((w) => {
      if (s.lockedIds.includes(w.id)) return w;
      const next = queue.shift();
      if (!next) return w;
      replaced++;
      used.add(normalize(next.word));
      return { ...next, id: newId("w") };
    });
    return edited(s, words, s.lockedIds);
  });
  return { activity, replaced };
}

export function addSet(a: Activity, words: VocabWord[]): Activity {
  const title = `Set ${a.sets.length + 1}`;
  return touch({ ...a, sets: [...a.sets, createSet(words, title)] });
}

export function removeSet(a: Activity, setId: string): Activity {
  return touch({ ...a, sets: a.sets.filter((s) => s.id !== setId) });
}

/** Reasons a set cannot be approved yet (empty array = ready). */
export function approvalProblems(set: StudioSet): string[] {
  const problems: string[] = [];
  if (set.words.length !== SET_SIZE) problems.push(`A set needs exactly ${SET_SIZE} words (this one has ${set.words.length}).`);
  const seen = new Set<string>();
  set.words.forEach((w, i) => {
    const key = normalize(w.word);
    if (seen.has(key)) problems.push(`Word ${i + 1} (“${w.word}”) is a duplicate.`);
    seen.add(key);
    const errs = validateWord(w).filter((x) => x.severity === "error");
    if (hasErrors(errs)) problems.push(`Word ${i + 1} (“${w.word || "empty"}”): ${errs.map((e) => e.message).join(" ")}`);
  });
  return problems;
}

export function approveSet(a: Activity, setId: string): { activity: Activity; problems: string[] } {
  const set = a.sets.find((s) => s.id === setId);
  if (!set) return { activity: a, problems: ["Set not found."] };
  const problems = approvalProblems(set);
  if (problems.length) return { activity: a, problems };
  return { activity: mapSet(a, setId, (s) => ({ ...s, status: "approved" })), problems: [] };
}

/** The shape the game consumes. */
export function toVocabSet(a: Activity, set: StudioSet): VocabSet {
  return {
    id: set.id,
    title: `${a.title} — ${set.title}`,
    description: a.brief.topic || "Teacher-made set",
    words: set.words,
  };
}

export function approvedSets(a: Activity): StudioSet[] {
  return a.sets.filter((s) => s.status === "approved");
}

/**
 * "Today's Words" for classroom hosting: the first approved AND complete (playable) set of the most recently
 * updated activity that has one. Drafts and incomplete sets never qualify; returns null when there is none,
 * so the caller can say so instead of falling back to the preset.
 */
export function todaysWords(activities: Activity[]): VocabSet | null {
  const newest = [...activities].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  for (const a of newest) {
    const set = approvedSets(a).find((s) => approvalProblems(s).length === 0);
    if (set) return toVocabSet(a, set);
  }
  return null;
}

/** Add words to the end of a set (used to top up a set that came back short). Never changes existing words. */
export function appendWords(a: Activity, setId: string, words: VocabWord[]): Activity {
  return mapSet(a, setId, (s) => {
    const have = new Set(s.words.map((w) => normalize(w.word)));
    const fresh = words.filter((w) => !have.has(normalize(w.word))).slice(0, Math.max(0, SET_SIZE - s.words.length));
    return edited(s, [...s.words, ...fresh.map((w) => ({ ...w, id: newId("w") }))]);
  });
}

/**
 * Split the teacher-approved word list into per-set chunks of up to `size` words, in order.
 * Generation then uses each chunk exactly; any shortfall in a set is filled freely.
 */
export function splitApproved(approved: string[], size = SET_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < approved.length; i += size) out.push(approved.slice(i, i + size));
  return out;
}

export type DifficultyBand = "familiar" | "moderate" | "challenging";

/** Descriptive only: how many words sit in each difficulty band (A1–A2 familiar, B1–B2 moderate, C1–C2 challenging). */
export function levelMix(words: VocabWord[]): Record<DifficultyBand, number> {
  const mix = { familiar: 0, moderate: 0, challenging: 0 };
  for (const w of words) {
    if (w.cefr === "A1" || w.cefr === "A2") mix.familiar++;
    else if (w.cefr === "B1" || w.cefr === "B2") mix.moderate++;
    else mix.challenging++;
  }
  return mix;
}

/** A gentle, non-blocking note about communication suitability — never about CEFR uniformity. */
export function mixAdvice(words: VocabWord[]): string | null {
  if (words.length < 4) return null;
  const m = levelMix(words);
  if (m.familiar === 0) return "No familiar words in this set — students may struggle to explain the harder ones. Consider adding a few everyday words as anchors.";
  if (m.familiar === words.length) return "Every word here is familiar — fine for warming up, but a few challenging words give students more to negotiate.";
  return null;
}

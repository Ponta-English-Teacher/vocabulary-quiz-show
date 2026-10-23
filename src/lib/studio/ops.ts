import { SAMPLE_SET, type Illustration, type VocabSet, type VocabWord } from "@/data/vocab";
import { normalize } from "@/lib/answer";
import { newId } from "./ids";
import { EMPTY_BRIEF, MIN_SET_WORDS, SET_SIZE, type Activity, type Brief, type MissingItem, type StudioSet } from "./types";
import { hasErrors, hintProblems, validateWord } from "./validation";
import { restrictionsFor, type Restriction } from "./restrictions";

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

/** Name a set (its list name in the Vocabulary Library). Renaming never changes the set's words or its approval. */
export function renameSet(a: Activity, setId: string, title: string): Activity {
  return touch({ ...a, sets: a.sets.map((s) => (s.id === setId ? { ...s, title: title.slice(0, 60) } : s)) });
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
  return mapSet(
    a,
    setId,
    (s) => {
      const target = s.words.find((w) => w.id === wordId);
      const base = edited(
        s,
        s.words.map((w) => {
          if (w.id !== wordId) return w;
          const next = { ...w, ...patch };
          // A picture drawn for another word would be wrong for this one.
          if (patch.word !== undefined && patch.word.trim() !== w.word.trim() && !("illustration" in patch)) delete next.illustration;
          return next;
        }),
      );
      if (!target || patch.hints === undefined) return base;
      // What the teacher types is remembered per hint, so an AI rewrite of another hint cannot overwrite it.
      const marks = new Set(s.handHints?.[wordId] ?? []);
      patch.hints.forEach((h, i) => {
        if (!(h ?? "").trim()) marks.delete(i);
        else if (h !== (target.hints[i] ?? "")) marks.add(i);
      });
      const hand = { ...(s.handHints ?? {}) };
      if (marks.size) hand[wordId] = [...marks].sort();
      else delete hand[wordId];
      const { handHints: _old, ...rest } = base;
      void _old;
      return Object.keys(hand).length ? { ...rest, handHints: hand } : rest;
    },
    now,
  );
}

/** Hints the teacher wrote by hand for this word that are still filled in. Clearing a hint hands it back to the AI. */
export function protectedHints(set: StudioSet, w: VocabWord): number[] {
  return (set.handHints?.[w.id] ?? []).filter((i) => (w.hints[i] ?? "").trim());
}

/**
 * Attach (or remove, with undefined) a word's picture. A picture is not part of what the teacher reviews as text,
 * so this does NOT send an approved set back to draft.
 */
export function setIllustration(a: Activity, setId: string, wordId: string, illustration: Illustration | undefined, now?: string): Activity {
  return mapSet(
    a,
    setId,
    (s) => ({
      ...s,
      words: s.words.map((w) => {
        if (w.id !== wordId) return w;
        const { illustration: _old, ...rest } = w;
        void _old;
        return illustration ? { ...rest, illustration } : rest;
      }),
    }),
    now,
  );
}

/** Replace a word's hints outright (not recorded as the teacher's own wording). The AI paths use applyAiHints, which protects hand-written hints. */
export function setHints(a: Activity, setId: string, wordId: string, hints: string[]): Activity {
  return mapSet(a, setId, (s) => edited(s, s.words.map((w) => (w.id === wordId ? { ...w, hints } : w))));
}

/**
 * AI-written hints go in only where the teacher has not written their own: hints in `protectedHints` are kept as they are, and
 * `only` (if given) limits the change to those positions. Returns what was kept and what changed.
 */
export function applyAiHints(a: Activity, setId: string, wordId: string, fresh: string[], only?: number[]): { activity: Activity; kept: number[]; changed: number[] } {
  const set = a.sets.find((s) => s.id === setId);
  const word = set?.words.find((w) => w.id === wordId);
  if (!set || !word) return { activity: a, kept: [], changed: [] };
  const mine = protectedHints(set, word);
  const kept = [0, 1, 2].filter((i) => mine.includes(i) && (!only || only.includes(i)));
  const changed = [0, 1, 2].filter((i) => !mine.includes(i) && (!only || only.includes(i)) && (fresh[i] ?? "") !== (word.hints[i] ?? ""));
  if (!changed.length) return { activity: a, kept, changed };
  const hints = [0, 1, 2].map((i) => (changed.includes(i) ? fresh[i] : word.hints[i] ?? ""));
  return {
    activity: mapSet(a, setId, (s) => edited(s, s.words.map((w) => (w.id === wordId ? { ...w, hints } : w)))),
    kept,
    changed,
  };
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
    // A word the teacher has written hints for is kept like a locked word: regenerating the set never overwrites their wording.
    const keep = (w: VocabWord) => s.lockedIds.includes(w.id) || protectedHints(s, w).length > 0;
    const used = new Set(s.words.filter(keep).map((w) => normalize(w.word)));
    const queue = fresh.filter((f) => !used.has(normalize(f.word)));
    const words = s.words.map((w) => {
      if (keep(w)) return w;
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

export function addSet(a: Activity, words: VocabWord[], opts: { requested?: number; missing?: MissingItem[]; flaggedWords?: string[] } = {}): Activity {
  const title = `Set ${a.sets.length + 1}`;
  const set = createSet(words, title);
  if (opts.requested !== undefined) set.requested = opts.requested;
  if (opts.missing?.length) set.missing = opts.missing;
  const flagged = (opts.flaggedWords ?? []).flatMap((w) => set.words.filter((x) => normalize(x.word) === normalize(w)).map((x) => x.id));
  if (flagged.length) set.flagged = flagged;
  return touch({ ...a, sets: [...a.sets, set] });
}

/** Flagged words whose hints are STILL not right. Fixing the hints by hand or by AI clears the flag by itself. */
export function wordsNeedingHints(set: StudioSet, restrictions: readonly Restriction[] = []): { word: VocabWord; reasons: string[]; hints: number[] }[] {
  // Flagged words are checked in full; any other word is checked only against the teacher's restrictions (so a restriction added
  // later, or a hand edit that breaks one, is never accepted silently).
  const flagged = new Set(set.flagged ?? []);
  return set.words.flatMap((w) => {
    const problems = flagged.has(w.id) ? hintProblems(w, restrictions) : hintProblems(w, restrictions).filter((p) => p.code === "restriction");
    return problems.length ? [{ word: w, reasons: problems.map((p) => p.message), hints: [...new Set(problems.flatMap((p) => (p.hintIndex === undefined ? [] : [p.hintIndex])))] }] : [];
  });
}

/** Counts for the lineup: words the teacher selected, items that are complete and valid, and words that still need correction. */
export function setProgress(set: StudioSet, restrictions: readonly Restriction[] = []): { approved: number; written: number; failed: number; needHints: number; valid: number; needCorrection: number } {
  const failed = set.missing?.length ?? 0;
  const needHints = wordsNeedingHints(set, restrictions).length;
  return {
    approved: set.requested ?? set.words.length + failed,
    written: set.words.length,
    failed,
    needHints,
    valid: set.words.length - needHints,
    needCorrection: failed + needHints,
  };
}

/** A retry produced the missing word's item: put it back where it belongs. Every other word is untouched. */
export function fillMissing(a: Activity, setId: string, word: string, item: VocabWord): { activity: Activity; error?: string } {
  const set = a.sets.find((s) => s.id === setId);
  const miss = set?.missing?.find((m) => normalize(m.word) === normalize(word));
  if (!set || !miss) return { activity: a, error: "That word is no longer waiting for an item." };
  if (set.words.some((w) => normalize(w.word) === normalize(item.word))) return { activity: a, error: `“${item.word}” is already in this set.` };
  const fresh: VocabWord = { ...item, id: newId("w") };
  return {
    activity: mapSet(a, setId, (s) => {
      const words = [...s.words];
      words.splice(Math.min(miss.index, words.length), 0, fresh);
      const left = (s.missing ?? []).filter((m) => normalize(m.word) !== normalize(word));
      const { missing: _m, ...rest } = s;
      void _m;
      return edited({ ...rest, ...(left.length ? { missing: left } : {}) }, words);
    }),
  };
}

/** A retry failed again: keep the word waiting, with the new reason. */
export function noteMissingFailure(a: Activity, setId: string, word: string, reason: string): Activity {
  return mapSet(a, setId, (s) => ({ ...s, missing: (s.missing ?? []).map((m) => (normalize(m.word) === normalize(word) ? { ...m, reason } : m)) }));
}

/** The teacher decides to give up on one word. Only this explicit action removes it. */
export function dropMissing(a: Activity, setId: string, word: string): Activity {
  return mapSet(a, setId, (s) => {
    const left = (s.missing ?? []).filter((m) => normalize(m.word) !== normalize(word));
    const { missing: _m, ...rest } = s;
    void _m;
    return { ...rest, ...(left.length ? { missing: left } : {}), ...(s.requested !== undefined ? { requested: Math.max(s.words.length, s.requested - 1) } : {}) };
  });
}

export function removeSet(a: Activity, setId: string): Activity {
  return touch({ ...a, sets: a.sets.filter((s) => s.id !== setId) });
}

/** Reasons a set cannot be approved yet (empty array = ready). */
export function approvalProblems(set: StudioSet, restrictions: readonly Restriction[] = []): string[] {
  const problems: string[] = [];
  if (set.words.length < MIN_SET_WORDS || set.words.length > SET_SIZE) problems.push(`A set needs ${MIN_SET_WORDS} to ${SET_SIZE} words (this one has ${set.words.length}).`);
  if (set.missing?.length) {
    problems.push(`${set.missing.length} approved word${set.missing.length === 1 ? " has" : "s have"} no item yet: ${set.missing.map((m) => `“${m.word}”`).join(", ")}. Retry ${set.missing.length === 1 ? "it" : "them"} or remove ${set.missing.length === 1 ? "it" : "them"} from the set first.`);
  }
  for (const f of wordsNeedingHints(set, restrictions)) {
    problems.push(`“${f.word.word}” still needs its hints corrected (${f.hints.length ? `hint${f.hints.length === 1 ? "" : "s"} ${f.hints.map((h) => h + 1).join(", ")}: ` : ""}${f.reasons.join(" ")}).`);
  }
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

/** The teacher explicitly reopens an approved set for editing. Nothing else ever changes an approved set's status. */
export function reopenSet(a: Activity, setId: string): Activity {
  const set = a.sets.find((s) => s.id === setId);
  if (!set || set.status !== "approved") return a;
  return mapSet(a, setId, (s) => ({ ...s, status: "draft" }));
}

export function approveSet(a: Activity, setId: string): { activity: Activity; problems: string[] } {
  const set = a.sets.find((s) => s.id === setId);
  if (!set) return { activity: a, problems: ["Set not found."] };
  const problems = approvalProblems(set, restrictionsFor(a.brief.learnerFocus));
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
 * Generation then uses each chunk exactly; a chunk may hold fewer than `size` words (the set is then that small).
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

import { normalize } from "@/lib/answer";
import { EMPTY_BANDS, MAX_CANDIDATES, type Brief, type CandidateBands } from "./types";

/**
 * The teacher's candidate word list, before approval. Pure operations on a Brief: each returns a NEW brief (or an error)
 * and touches only the word it names. Nothing here calls the AI.
 *
 *  - `candidates` is the list the teacher sees (and that Generate / "go ahead" uses, exactly).
 *  - `candidateBands` only groups some of them by familiarity for display; a word that is in no band is shown as "Your words".
 *  - `pinnedCandidates` = words the teacher typed in (added, or replaced/edited into): the AI can't drop them later.
 *  - `removedCandidates` = words the teacher deleted or replaced: the AI can't bring them back.
 */

const MAX_WORD = 60;
const key = (w: string) => normalize(w);
const has = (list: readonly string[], w: string) => list.some((x) => key(x) === key(w));
const without = (list: readonly string[], w: string) => list.filter((x) => key(x) !== key(w));
const dedupe = (list: readonly string[]) => {
  const seen = new Set<string>();
  return list.filter((w) => (seen.has(key(w)) ? false : (seen.add(key(w)), true)));
};
const bandsWithout = (b: CandidateBands, w: string): CandidateBands => ({
  familiar: without(b.familiar, w), moderate: without(b.moderate, w), unfamiliar: without(b.unfamiliar, w),
});
const bandOf = (b: CandidateBands, w: string): keyof CandidateBands | null =>
  has(b.familiar, w) ? "familiar" : has(b.moderate, w) ? "moderate" : has(b.unfamiliar, w) ? "unfamiliar" : null;

export type CandidateResult = { ok: true; brief: Brief } | { ok: false; error: string };

/** What the teacher typed, cleaned up; null when it can't be a word or phrase. */
export function cleanCandidate(input: string): string | null {
  const w = input.replace(/\s+/g, " ").trim().slice(0, MAX_WORD);
  return w && key(w) ? w : null;
}

export function countCandidates(brief: Brief): number {
  return brief.candidates.length;
}

/** Add one word by hand (at the end of the list). */
export function addCandidate(brief: Brief, input: string): CandidateResult {
  const w = cleanCandidate(input);
  if (!w) return { ok: false, error: "Type a word or phrase to add." };
  if (has(brief.candidates, w)) return { ok: false, error: `“${w}” is already in the list.` };
  if (brief.candidates.length >= MAX_CANDIDATES) return { ok: false, error: `The list can hold at most ${MAX_CANDIDATES} words.` };
  return {
    ok: true,
    brief: {
      ...brief,
      candidates: [...brief.candidates, w],
      pinnedCandidates: [...without(brief.pinnedCandidates, w), w],
      removedCandidates: without(brief.removedCandidates, w),
    },
  };
}

/** Delete one word. It stays deleted when the conversation continues. */
export function removeCandidate(brief: Brief, word: string): CandidateResult {
  if (!has(brief.candidates, word)) return { ok: false, error: "That word is no longer in the list." };
  return {
    ok: true,
    brief: {
      ...brief,
      candidates: without(brief.candidates, word),
      candidateBands: bandsWithout(brief.candidateBands, word),
      pinnedCandidates: without(brief.pinnedCandidates, word),
      removedCandidates: [...without(brief.removedCandidates, word), word],
    },
  };
}

/** Edit or replace one word in place: same position, same familiarity group. The old word counts as deleted. */
export function replaceCandidate(brief: Brief, word: string, input: string): CandidateResult {
  const next = cleanCandidate(input);
  if (!next) return { ok: false, error: "Type the new word." };
  if (!has(brief.candidates, word)) return { ok: false, error: "That word is no longer in the list." };
  if (key(next) === key(word)) {
    // Only spelling/capitalisation changed: keep the position and the group, just store the new text.
    const swap = (l: string[]) => l.map((x) => (key(x) === key(word) ? next : x));
    return {
      ok: true,
      brief: { ...brief, candidates: swap(brief.candidates), pinnedCandidates: [...without(brief.pinnedCandidates, word), next],
        candidateBands: { familiar: swap(brief.candidateBands.familiar), moderate: swap(brief.candidateBands.moderate), unfamiliar: swap(brief.candidateBands.unfamiliar) } },
    };
  }
  if (has(brief.candidates, next)) return { ok: false, error: `“${next}” is already in the list.` };
  const band = bandOf(brief.candidateBands, word);
  const swap = (l: string[]) => l.map((x) => (key(x) === key(word) ? next : x));
  return {
    ok: true,
    brief: {
      ...brief,
      candidates: swap(brief.candidates),
      candidateBands: band ? { ...bandsWithout(brief.candidateBands, word), [band]: swap(brief.candidateBands[band]) } : brief.candidateBands,
      pinnedCandidates: [...without(without(brief.pinnedCandidates, word), next), next],
      removedCandidates: [...without(brief.removedCandidates, next), ...(has(brief.removedCandidates, word) ? [] : [word])],
    },
  };
}

/**
 * The conversation went on and the AI sent back ITS candidate list. Combine it with the teacher's:
 *  - words the teacher deleted (or replaced) never come back;
 *  - words the teacher typed in are never dropped, and are never re-spelled;
 *  - other words follow the AI (so "swap #3 for something easier" still works);
 *  - the teacher's own words keep their familiarity group.
 * `approvedWords` and the teacher's bookkeeping are always taken from the teacher's brief, never from the model.
 */
export function mergeAiCandidates(prev: Brief, ai: Brief): Brief {
  const removed = prev.removedCandidates, pinned = prev.pinnedCandidates;
  const fromAi = dedupe(ai.candidates).filter((w) => !has(removed, w));
  const keptPinned = pinned.filter((p) => has(prev.candidates, p) && !has(fromAi, p));
  // A pinned word keeps the teacher's spelling even if the AI proposes the same word again.
  const spelled = fromAi.map((w) => pinned.find((p) => key(p) === key(w)) ?? w);
  const candidates = dedupe([...spelled, ...keptPinned]).slice(0, MAX_CANDIDATES);
  const place = (w: string): keyof CandidateBands | null => bandOf(ai.candidateBands, w) ?? bandOf(prev.candidateBands, w);
  const bands: CandidateBands = { familiar: [], moderate: [], unfamiliar: [] };
  for (const w of candidates) {
    const b = place(w);
    if (b) bands[b].push(w);
  }
  const anyBand = bands.familiar.length + bands.moderate.length + bands.unfamiliar.length > 0;
  return {
    ...ai,
    candidates,
    candidateBands: anyBand ? bands : EMPTY_BANDS,
    pinnedCandidates: pinned.filter((p) => has(candidates, p)),
    removedCandidates: removed,
    approvedWords: ai.approvedWords,
  };
}

/** Candidate words grouped for display: the AI's groups, then everything else as "your words". */
export function groupedCandidates(brief: Brief): { key: "familiar" | "moderate" | "unfamiliar" | "other"; words: string[] }[] {
  const out: { key: "familiar" | "moderate" | "unfamiliar" | "other"; words: string[] }[] = [];
  for (const k of ["familiar", "moderate", "unfamiliar"] as const) {
    const words = brief.candidates.filter((w) => has(brief.candidateBands[k], w));
    if (words.length) out.push({ key: k, words });
  }
  const grouped = new Set(out.flatMap((g) => g.words.map(key)));
  const other = brief.candidates.filter((w) => !grouped.has(key(w)));
  if (other.length) out.push({ key: "other", words: other });
  return out;
}

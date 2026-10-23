/**
 * Teacher restrictions on hint CONTENT that the app can check without another AI call.
 *
 * The teacher's wishes live in free text (brief.learnerFocus, plus a one-off instruction). A small, fixed list of
 * restriction kinds is recognised from that text and checked with plain word patterns:
 *
 *   calendar-order  clues that place a day/month in the calendar sequence ("comes after Monday", "second day of the week")
 *   first-letter    "starts with u", "the first letter is …"
 *   word-origin     etymology ("comes from Latin", "named after a god")
 *
 * Which hints a restriction covers is read from the same text ("in Hints 1 and 2", "until Hint 3", "only in Hint 3").
 * Notes are read oldest → newest, so the LATEST explicit instruction wins when the teacher changes their mind.
 * Anything else a teacher asks for (tone, themes, "use food examples", "keep it funny") is NOT checked: it can only be
 * judged by a model, and the app does not make an extra paid call for that.
 */

export type RestrictionKind = "calendar-order" | "first-letter" | "word-origin";

export interface Restriction {
  kind: RestrictionKind;
  /** 0-based indexes of the hints the restriction applies to. */
  hints: number[];
}

export interface RestrictionProblem {
  hintIndex: number;
  kind: RestrictionKind;
  message: string;
}

const LABEL: Record<RestrictionKind, string> = {
  "calendar-order": "calendar-order clue",
  "first-letter": "first-letter clue",
  "word-origin": "word-origin clue",
};

const KEYWORDS: Record<RestrictionKind, RegExp> = {
  "calendar-order": /calendar|order of (?:the )?(?:days?|week|months?)|(?:day|weekday|week|month)s?[- ]order|sequence|what comes (?:before|after)|(?:before|after) (?:and|or) (?:before|after)/i,
  "first-letter": /first[- ]letters?|starts? with|starting with|begins? with|initial letter/i,
  "word-origin": /etymolog|\borigins?\b|where (?:the|a) word comes from|named after/i,
};

const NEGATIVE = /\b(?:do not|don't|dont|never|avoid|no|not|without|ban|banned|forbid|forbidden|must not|mustn't|shouldn't|should not|skip|leave out)\b/i;
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3" };

function hintNumbers(s: string): number[] {
  const text = s.replace(/\b(hints?)\s+(one|two|three)\b/gi, (_m, h, n) => `${h} ${NUMBER_WORDS[String(n).toLowerCase()]}`);
  const out = new Set<number>();
  for (const m of text.matchAll(/hints?\s*((?:[1-3]\s*(?:,|and|&|or|to|-|–)?\s*)+)/gi)) {
    const body = m[1];
    const range = /([1-3])\s*(?:to|-|–)\s*([1-3])/.exec(body);
    if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) out.add(n);
    for (const n of body.matchAll(/[1-3]/g)) out.add(Number(n[0]));
  }
  return [...out].sort();
}

const sentencesOf = (notes: (string | undefined)[]) => notes.filter((n): n is string => !!n && !!n.trim()).flatMap((n) => n.split(/(?<=[.!?。])\s+|\n+/)).map((x) => x.trim()).filter(Boolean);

/** The sentences of a teacher message that state a checkable restriction (including a follow-up such as "Such clues are permitted in Hint 3."). */
export function restrictionSentences(text: string | undefined): string[] {
  let last: boolean = false;
  const out: string[] = [];
  for (const s of sentencesOf([text])) {
    const named = (Object.keys(KEYWORDS) as RestrictionKind[]).some((k) => KEYWORDS[k].test(s));
    const follows: boolean = !named && last && /\b(?:such|these|those|them|they|it|that)\b/i.test(s);
    last = named || follows;
    if (last) out.push(s);
  }
  return out;
}

/** Read restrictions from teacher notes given oldest → newest. Later sentences override earlier ones. */
export function parseRestrictions(notes: (string | undefined)[]): Restriction[] {
  const state = new Map<RestrictionKind, Set<number>>();
  let last: RestrictionKind[] = [];
  const sentences = sentencesOf(notes);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    let kinds = (Object.keys(KEYWORDS) as RestrictionKind[]).filter((k) => KEYWORDS[k].test(s));
    if (!kinds.length) kinds = /\b(?:such|these|those|them|they|it|that)\b/i.test(s) ? last : [];
    last = kinds;
    if (!kinds.length) continue;

    const refs = hintNumbers(s);
    const until = /\b(?:until|before|up to|till)\s+hints?\s*([1-3])/i.exec(s);
    const only = /\b(?:only|except)\b[^.]*?\bhints?\s*([1-3])/i.exec(s);
    const negative = NEGATIVE.test(s);
    for (const k of kinds) {
      const set = state.get(k) ?? new Set<number>();
      if (negative) {
        if (until) {
          for (let i = 0; i < Number(until[1]) - 1; i++) set.add(i);
        } else if (only) {
          for (const i of [0, 1, 2]) if (i !== Number(only[1]) - 1) set.add(i);
        } else if (refs.length) {
          for (const n of refs) set.add(n - 1);
        } else {
          for (const i of [0, 1, 2]) set.add(i);
        }
      } else if (only && /\bonly\b/i.test(s)) {
        for (const i of [0, 1, 2]) if (i !== Number(only[1]) - 1) set.add(i); // "calendar clues only in hint 3"
      } else if (refs.length) {
        for (const n of refs) set.delete(n - 1); // "permitted in hint 3"
      } else {
        set.clear(); // "calendar clues are fine now"
      }
      state.set(k, set);
    }
  }
  return [...state].filter(([, set]) => set.size).map(([kind, set]) => ({ kind, hints: [...set].sort() }));
}

/** The restrictions that apply to a brief, plus an optional one-off instruction (which is the newest). */
export const restrictionsFor = (learnerFocus: string | undefined, instruction?: string): Restriction[] => parseRestrictions([learnerFocus, instruction]);

const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const MONTHS = "january|february|march|april|june|july|august|september|october|november|december";
const CALENDAR_TERM = new RegExp(`^(?:${DAYS}|${MONTHS}|weeks?|weekends?|weekdays?)$`);
const SEQUENCE_CUE = /^(?:before|after|next|previous|following|between|middle|first|second|third|fourth|fifth|sixth|seventh|last|starts?|started|starting|begin|begins|beginning|ends?|ended|ending|early|late|near|close|then|since|until|halfway|half|mid|midweek|over|leads?|leading|toward|towards)$/;

function calendarClue(hint: string): string | null {
  const tokens = hint.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (!CALENDAR_TERM.test(tokens[i])) continue;
    for (let j = Math.max(0, i - 4); j <= Math.min(tokens.length - 1, i + 4); j++) {
      if (j !== i && SEQUENCE_CUE.test(tokens[j])) return tokens.slice(Math.min(i, j), Math.max(i, j) + 1).join(" ");
    }
  }
  return null;
}

const FIRST_LETTER = /\b(?:starts?|starting|begins?|beginning) with\b|\bfirst letter\b|\binitial\b/i;
const WORD_ORIGIN = /\b(?:comes? from|come from|derived|named (?:after|for)|origin|etymolog\w*|name is (?:connected|related|linked)|old english|old norse|latin|greek|norse)\b/i;

function violation(kind: RestrictionKind, hint: string): string | null {
  if (kind === "calendar-order") return calendarClue(hint);
  const m = (kind === "first-letter" ? FIRST_LETTER : WORD_ORIGIN).exec(hint);
  return m ? m[0] : null;
}

const hintList = (idx: number[]) => `hint${idx.length === 1 ? "" : "s"} ${idx.map((i) => i + 1).join(" and ")}`;

/** Check a word's hints against the restrictions. Pure and free: no model call. */
export function restrictionProblems(hints: readonly string[], restrictions: readonly Restriction[]): RestrictionProblem[] {
  const out: RestrictionProblem[] = [];
  for (const r of restrictions) {
    for (const i of r.hints) {
      const text = hints[i];
      if (!text) continue;
      const hit = violation(r.kind, text);
      if (hit) out.push({ hintIndex: i, kind: r.kind, message: `Hint ${i + 1} has a ${LABEL[r.kind]} (“${hit}”), but your instructions ask for none in ${hintList(r.hints)}.` });
    }
  }
  return out.sort((a, b) => a.hintIndex - b.hintIndex);
}

/**
 * Keep the restriction sentences of a teacher message in the brief notes, so they are still enforced later. Only checkable
 * restriction sentences are kept (never the rest of the message); newest text is last, so it wins. At most 500 characters.
 */
export function withRestrictionNote(learnerFocus: string, ...messages: (string | undefined)[]): string {
  let focus = learnerFocus.trim();
  for (const m of messages) {
    for (const sentence of restrictionSentences(m)) if (!focus.includes(sentence)) focus = `${focus} ${sentence}`.trim();
  }
  return focus.length > 500 ? focus.slice(focus.length - 500) : focus;
}

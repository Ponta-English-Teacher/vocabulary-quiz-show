import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { WordRow } from "@/components/studio/WordRow";
import { handleStudioRequest } from "./ai/service";
import { addSet, applyAiHints, approvalProblems, approveSet, createActivity, protectedHints, regenerateSet, setBrief, todaysWords, updateWord, wordsNeedingHints } from "./ops";
import { loadActivities, saveActivity, duplicateActivity, type StorageLike } from "./storage";
import { parseRestrictions, restrictionsFor, withRestrictionNote } from "./restrictions";
import { validateWord } from "./validation";
import { EMPTY_BRIEF, type Brief } from "./types";

const NO_CAL = "Do not use calendar-order clues in Hints 1 and 2. Calendar-order clues are allowed in Hint 3.";
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const hintsFor = (w: string) => [`You hear the alarm and see your ${w.length}-letter plan on the kitchen wall.`, "People often have a regular class or meeting at that time.", "It is the one with its own old story and a small joke."];
const mk = (word: string, i: number) => ({ id: `w${i}`, word, accept: [], partOfSpeech: "noun", cefr: "A1", category: "Days", meaning: "a day", example: `See you on ${word}.`, hints: hintsFor(word) }) as never;
const brief = (focus = ""): Brief => ({ ...EMPTY_BRIEF, topic: "Weekdays", level: "A2", learnerFocus: focus });
const memory = (): StorageLike => { const d: Record<string, string> = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };
const build = (n = 5, focus = NO_CAL) => addSet(setBrief(createActivity("T", "2026-04-01T00:00:00Z"), brief(focus)), WEEK.slice(0, n).map(mk), { requested: n });

describe("editing hints one at a time", () => {
  it("editing hint 2 changes only hint 2; the other two hints and the other words stay identical", () => {
    const a = build();
    const set = a.sets[0];
    const w = set.words[1];
    const b = updateWord(a, set.id, w.id, { hints: [w.hints[0], "People call this one the blue day for no clear reason.", w.hints[2]] });
    const after = b.sets[0].words;
    expect(after[1].hints).toEqual([w.hints[0], "People call this one the blue day for no clear reason.", w.hints[2]]);
    expect(after.filter((_, i) => i !== 1)).toEqual(set.words.filter((_, i) => i !== 1));
    expect(protectedHints(b.sets[0], after[1])).toEqual([1]);
  });
  it("each of the three hints can be edited independently, and clearing one hands it back", () => {
    let a = build();
    const id = a.sets[0].id;
    const wid = a.sets[0].words[0].id;
    for (const i of [0, 1, 2]) {
      const cur = a.sets[0].words[0].hints;
      const next = [...cur];
      next[i] = `My own hint number ${i + 1} about a Monday morning rush.`;
      a = updateWord(a, id, wid, { hints: next });
      expect(a.sets[0].words[0].hints.filter((_, k) => k !== i)).toEqual(cur.filter((_, k) => k !== i));
    }
    expect(protectedHints(a.sets[0], a.sets[0].words[0])).toEqual([0, 1, 2]);
    const cleared = [...a.sets[0].words[0].hints];
    cleared[1] = "";
    a = updateWord(a, id, wid, { hints: cleared });
    expect(protectedHints(a.sets[0], a.sets[0].words[0])).toEqual([0, 2]);
  });
  it("other edits (definition, category) do not mark hints as hand-written", () => {
    const a = updateWord(build(), build().sets[0].id, "w0", { meaning: "x" });
    expect(a.sets[0].handHints).toBeUndefined();
  });
});

describe("AI rewrites never overwrite the teacher's wording", () => {
  const edited = () => {
    const a = build();
    const id = a.sets[0].id;
    const w = a.sets[0].words[0];
    return { a: updateWord(a, id, w.id, { hints: ["My own opening about the alarm on a grey morning.", w.hints[1], w.hints[2]] }), id, wid: w.id };
  };
  it("a rewrite of the other hints keeps the hand-written hint 1 exactly", () => {
    const { a, id, wid } = edited();
    const r = applyAiHints(a, id, wid, ["AI one", "AI two for the class", "AI three for the story"]);
    expect(r.kept).toEqual([0]);
    expect(r.changed).toEqual([1, 2]);
    expect(r.activity.sets[0].words[0].hints).toEqual(["My own opening about the alarm on a grey morning.", "AI two for the class", "AI three for the story"]);
  });
  it("an AI repair of one hint (only) leaves manual edits in the same word untouched", () => {
    const { a, id, wid } = edited();
    const r = applyAiHints(a, id, wid, ["AI one", "AI two for the class", "AI three for the story"], [2]);
    expect(r.activity.sets[0].words[0].hints).toEqual(["My own opening about the alarm on a grey morning.", a.sets[0].words[0].hints[1], "AI three for the story"]);
  });
  it("when the only hint to change is the teacher's own, nothing changes", () => {
    const { a, id, wid } = edited();
    const r = applyAiHints(a, id, wid, ["AI one", "b", "c"], [0]);
    expect(r.changed).toEqual([]);
    expect(r.activity).toBe(a);
  });
  it("after the teacher clears a hint the AI may write it again", () => {
    const { a, id, wid } = edited();
    const cleared = updateWord(a, id, wid, { hints: ["", a.sets[0].words[0].hints[1], a.sets[0].words[0].hints[2]] });
    expect(applyAiHints(cleared, id, wid, ["AI one is new", "x", "y"], [0]).activity.sets[0].words[0].hints[0]).toBe("AI one is new");
  });
  it("regenerating the whole set keeps words the teacher wrote hints for, like locked words", () => {
    const { a, id } = edited();
    const fresh = ["Sunday", "Saturday", "Easter", "Birthday", "Holiday"].map((w, i) => mk(w, 50 + i));
    const r = regenerateSet(a, id, fresh);
    expect(r.activity.sets[0].words[0].word).toBe("Monday");
    expect(r.activity.sets[0].words[0].hints[0]).toMatch(/^My own opening/);
    expect(r.replaced).toBe(4);
  });
});

describe("warnings on manual edits", () => {
  it("a hand-written hint that contains the word is flagged at its hint, and fixing it clears the warning", () => {
    const w = mk("Tuesday", 1) as { hints: string[] } & Record<string, unknown>;
    const bad = { ...w, hints: [w.hints[0], "Tuesday is the one after the first day.", w.hints[2]] } as never;
    const issues = validateWord(bad).filter((i) => i.field === "hints" && i.severity === "error");
    expect(issues.map((i) => i.hintIndex)).toEqual([1]);
    expect(validateWord({ ...(bad as object), hints: w.hints } as never).filter((i) => i.field === "hints" && i.severity === "error")).toEqual([]);
  });
  it("a hand-written calendar-order clue in hint 1 is warned about at the field; in hint 3 it is allowed", () => {
    const r = restrictionsFor(NO_CAL);
    const w = mk("Tuesday", 1) as { hints: string[] } & Record<string, unknown>;
    const v = (hints: string[]) => validateWord({ ...w, hints } as never, r).filter((i) => i.code === "restriction");
    expect(v(["It comes after Monday.", w.hints[1], w.hints[2]]).map((i) => i.hintIndex)).toEqual([0]);
    expect(v(["It comes after Monday.", w.hints[1], w.hints[2]])[0].message).toMatch(/calendar-order clue/);
    expect(v([w.hints[0], w.hints[1], "It comes after Monday."])).toEqual([]);
  });
  it("the editor shows the warning next to the hint and the progress/approval logic follows", () => {
    const word = { ...(mk("Tuesday", 1) as object), hints: ["It comes after Monday.", "People have class that day.", "It is the day after the first day."] } as never;
    const props = { index: 1, word, locked: false, open: true, disabled: false, busyWordId: null, onToggleOpen: () => undefined, onEdit: () => undefined, onToggleLock: () => undefined, onReplace: () => undefined, onNewHints: () => undefined, onIllustrate: () => undefined, onRemoveIllustration: () => undefined };
    const withR = renderToStaticMarkup(h(WordRow, { ...props, restrictions: restrictionsFor(NO_CAL) }));
    expect(withR).toMatch(/Hint 1 has a calendar-order clue/);
    expect(renderToStaticMarkup(h(WordRow, props))).not.toMatch(/calendar-order clue/);
    expect(withR).toMatch(/never overwritten by the AI/);
  });
  it("approval is unavailable while a hand-edited hint violates the restriction and returns when it is valid", () => {
    let a = build();
    const id = a.sets[0].id;
    const w = a.sets[0].words[2];
    a = updateWord(a, id, w.id, { hints: ["It is the day after Tuesday.", w.hints[1], w.hints[2]] });
    const refused = approveSet(a, id);
    expect(refused.problems.join(" ")).toMatch(/“Wednesday” still needs its hints corrected \(hint 1:/);
    expect(wordsNeedingHints(a.sets[0], restrictionsFor(NO_CAL)).map((x) => x.hints)).toEqual([[0]]);
    a = updateWord(a, id, w.id, { hints: ["You may hear people call this day by a funny camel name.", w.hints[1], w.hints[2]] });
    expect(approvalProblems(a.sets[0], restrictionsFor(NO_CAL))).toEqual([]);
    expect(approveSet(a, id).problems).toEqual([]);
  });
});

describe("saving, reloading, approving and hosting", () => {
  it("manual hints survive save → reload exactly, with the marks that protect them", () => {
    let a = build();
    const w = a.sets[0].words[3];
    a = updateWord(a, a.sets[0].id, w.id, { hints: [w.hints[0], "Its name has an old story about a thunder god.", "Many shops close early and the weekend is near."] });
    const store = memory();
    expect(saveActivity(store, a).ok).toBe(true);
    const back = loadActivities(store).activities[0];
    expect(back.sets[0].words[3].hints).toEqual(a.sets[0].words[3].hints);
    expect(back.sets[0].handHints).toEqual({ [w.id]: [1, 2] });
    expect(back.sets[0].words.map((x) => x.word)).toEqual(WEEK);
    // a copy keeps the wording and the protection under the new ids
    const copy = duplicateActivity(store, a.id);
    expect(copy.ok).toBe(true);
    const c = loadActivities(store).activities.find((x) => x.id !== a.id)!;
    expect(c.sets[0].words[3].hints[1]).toBe("Its name has an old story about a thunder god.");
    expect(Object.values(c.sets[0].handHints!)[0]).toEqual([1, 2]);
  });
  it("approving and hosting through Today's Words keeps the teacher's exact hints", () => {
    let a = build();
    const w = a.sets[0].words[1];
    const mine = ["You hear a rattle at the door; the neighbour's cat is back.", "People often have a swimming class that evening.", "The second day of the week, right after Monday."];
    a = updateWord(a, a.sets[0].id, w.id, { hints: mine });
    const ok = approveSet(a, a.sets[0].id);
    expect(ok.problems).toEqual([]);
    const t = todaysWords([ok.activity])!;
    expect(t.words.map((x) => x.word)).toEqual(WEEK);
    expect(t.words[1].hints).toEqual(mine);
    expect(t.words[0].hints).toEqual(hintsFor("Monday"));
  });
  it("sets of any length 1–10 and older sets without hand-written hints behave as before", () => {
    for (const n of [1, 3, 5]) {
      const a = build(n, "");
      expect(a.sets[0].handHints).toBeUndefined();
      const ok = approveSet(a, a.sets[0].id);
      expect(ok.problems).toEqual([]);
      expect(todaysWords([ok.activity])!.words).toHaveLength(n);
    }
    const ten = addSet(createActivity("T", "2026-04-01T00:00:00Z"), SAMPLE_SET.words.slice(0, 10).map((w, i) => ({ ...w, id: `s${i}` })));
    const approved = approveSet(ten, ten.sets[0].id);
    expect(approved.problems).toEqual([]);
    expect(todaysWords([approved.activity])!.words).toHaveLength(10);
    // an approved set stays exactly as it was when the brief later gains a restriction
    const later = setBrief(approved.activity, brief(NO_CAL));
    expect(todaysWords([later])!.words).toHaveLength(10);
  });
});

describe("the teacher's restriction is put in the brief by code, not by the model", () => {
  const chat = (modelFocus: string, msg: string, prevFocus = "") => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "ok", brief: { topic: "Weekdays", level: "A2", learnerFocus: modelFocus, objectives: [], balance: "", numSets: 1, avoid: [], wordType: "noun", approvalPending: true, candidates: WEEK, candidateBands: { familiar: WEEK, moderate: [], unfamiliar: [] } }, ready: true, command: null }) } }] }), { status: 200 }));
    return handleStudioRequest({ task: "chat", messages: [{ role: "teacher", text: msg }], brief: brief(prevFocus) } as never, { apiKey: "k", model: "m", fetchImpl: f as never });
  };
  const focusOf = (r: Awaited<ReturnType<typeof chat>>) => { if (!r.body.ok || r.body.data.task !== "chat") throw new Error("chat failed"); return r.body.data.result.brief.learnerFocus; };
  it("the real-AI case: the model left learnerFocus empty, but the restriction is still recorded and enforced", async () => {
    const focus = focusOf(await chat("", `A1-A2 days of the week: Monday to Friday. Use interesting, simple associations and everyday situations. ${NO_CAL}`));
    expect(focus).toContain("Do not use calendar-order clues in Hints 1 and 2.");
    expect(focus).toContain("Calendar-order clues are allowed in Hint 3.");
    expect(focus).not.toContain("Monday to Friday"); // only the restriction sentences, not the rest of the message
    expect(restrictionsFor(focus)).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
  });
  it("a later message that changes the preference wins, and an earlier restriction the model dropped is not lost", async () => {
    const dropped = focusOf(await chat("", "Please add a fun fact about the weekend.", NO_CAL));
    expect(restrictionsFor(dropped)).toEqual([{ kind: "calendar-order", hints: [0, 1] }]);
    const lifted = focusOf(await chat("", "Calendar-order clues are fine now.", NO_CAL));
    expect(restrictionsFor(lifted)).toEqual([]);
    expect(parseRestrictions([withRestrictionNote("", NO_CAL, "Calendar-order clues are fine now.")])).toEqual([]);
  });
  it("a message with no checkable restriction leaves the brief notes alone", async () => {
    expect(focusOf(await chat("Keep it friendly.", "Make it about food."))).toBe("Keep it friendly.");
  });
});

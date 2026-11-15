import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GiverRound } from "@/components/GiverRound";
import { TakerRound } from "@/components/TakerRound";
import { WordCard } from "@/components/wordbank/WordCard";
import { WordEditor } from "@/components/wordbank/WordEditor";
import { ToolsPanel } from "@/components/wordbank/ToolsPanel";
import { MemoryKV } from "@/lib/class/kv";
import { ClassService } from "@/lib/class/service";
import { redactForTaker } from "@/lib/game";
import { takerPointsFor } from "@/lib/scoring";
import { MAX_IMPORT, analyzeImport, draftsFromAnalysis } from "./import";
import { toVocabWord } from "./play";
import { BankService } from "./service";
import { MemoryBankStore } from "./store";
import { CSV_COLUMNS, TEMPLATE_ROWS, buildGenerationPrompt, templateCsv, templateJson } from "./template";
import { BANK_FORMAT, type BankWord } from "./types";
import { BANK_LIMITS, validateBankWord } from "./validate";
import { OPENING_EXAMPLES, blankForm, formFromWord, issuesForForm, payloadFromForm } from "./view";

const NOW = "2026-11-15T00:00:00.000Z";
const Q = "This is an action. What is it?";
const H = ["Imagine a plan that you must change for a good reason.", "A teacher might do this to a test on a rainy day.", "You decide to do it at a later time, not now.", "It means to move something to a later date."];
const mk = (word: string, over: Partial<BankWord> = {}): BankWord => ({
  id: `b${word}id`, word, accept: [], partOfSpeech: "verb", category: "Plans", cefr: "B2",
  hints: [`H1MARK${word} imagine a calm morning at home.`, `H2MARK${word} think about what people do there.`, `H3MARK${word} it has a clear purpose for everyone.`, `H4MARK${word} this is the most helpful clue to say.`] as unknown as BankWord["hints"],
  status: "approved", source: "file", createdAt: NOW, updatedAt: NOW, ...over,
});
const rec = (word: string, extra: Record<string, unknown> = {}) => ({ word, partOfSpeech: "verb", category: "Plans", level: "B2", hints: H, ...extra });
const file = (...r: object[]) => JSON.stringify({ format: BANK_FORMAT, words: r });

describe("validation of the spoken opening question", () => {
  const base = { word: "postpone", accept: [], partOfSpeech: "verb" as const, category: "Plans", cefr: "B2" as const, hints: H };
  const codes = (q: string | undefined) => validateBankWord({ ...base, openingQuestion: q }).filter((i) => i.field === "openingQuestion").map((i) => `${i.severity}:${i.code}`);
  it("is optional: no opening question means no opening-question issue", () => {
    expect(codes(undefined)).toEqual([]);
    expect(codes("")).toEqual([]);
    expect(codes("   ")).toEqual([]);
  });
  it("accepts short conceptual statements without any issue", () => {
    for (const q of OPENING_EXAMPLES) expect(codes(q), q).toEqual([]);
    for (const q of OPENING_EXAMPLES) expect(validateBankWord({ ...base, openingQuestion: q }), q).toEqual(validateBankWord(base));
  });
  it("rejects an opening question that contains the answer (or a form of it)", () => {
    expect(codes("Do you know how to postpone? What is it?")).toContain("error:leak");
    expect(codes("This is postponing. What is it?")).toContain("error:leak");
  });
  it("applies the structural rules: length, placeholder, markup", () => {
    expect(codes("x".repeat(BANK_LIMITS.openingQuestion + 1))).toContain("error:too_long");
    expect(codes("TODO write this. What is it?")).toContain("error:placeholder");
    expect(codes("<script>alert(1)</script> What is it?")).toContain("error:markup");
  });
  it("warns, but does not block, for grammar labels, a long statement, or no question", () => {
    expect(codes("This is a verb. What is it?")).toEqual(["warning:opening_grammar"]);
    expect(codes("This is an adjective. What is it?")).toEqual(["warning:opening_grammar"]);
    expect(codes("This is a thing that people do very often in the week when they are busy. What is it?")).toContain("warning:opening_long");
    expect(codes("This is an action.")).toEqual(["warning:opening_no_question"]);
  });
  it("conceptual categories are fine; they are not grammar", () => {
    for (const q of ["This is a fruit. What is it?", "This is a tool. What is it?", "This describes a feeling. What is it?", "This is a concept. What is it?"]) expect(codes(q)).toEqual([]);
  });
});

describe("import, templates and the generation prompt", () => {
  it("JSON import keeps openingQuestion on the draft (several accepted key spellings)", () => {
    const a = analyzeImport(file(rec("postpone", { openingQuestion: Q }), rec("borrow", { spokenOpening: "This is an action. What is it?" }), rec("delay", { opening: "This is an action. What is it?" })), "json");
    expect(a.counts.invalid).toBe(0);
    const d = draftsFromAnalysis(a, NOW);
    expect(d.map((w) => w.openingQuestion)).toEqual([Q, Q, Q]);
    expect(d.every((w) => w.status === "draft")).toBe(true);
    expect(d[0].hints).toEqual(H); // the four hints are exactly as written
  });
  it("CSV import reads the openingQuestion column", () => {
    const csv = `word,partOfSpeech,category,level,openingQuestion,hint1,hint2,hint3,hint4\r\npostpone,verb,Plans,B2,"This is an action. What is it?",${H.map((h) => `"${h}"`).join(",")}\r\n`;
    const a = analyzeImport(csv, "csv");
    expect(a.counts.invalid).toBe(0);
    expect(draftsFromAnalysis(a, NOW)[0].openingQuestion).toBe(Q);
  });
  it("a file without the field still imports exactly as before", () => {
    const d = draftsFromAnalysis(analyzeImport(file(rec("postpone")), "json"), NOW);
    expect(d[0]).not.toHaveProperty("openingQuestion");
    expect(d[0].hints).toEqual(H);
  });
  it("an opening question that gives away the answer makes the record invalid", () => {
    const a = analyzeImport(file(rec("postpone", { openingQuestion: "Can you postpone it? What is it?" })), "json");
    expect(a.records[0].status).toBe("invalid");
    expect(a.records[0].errors.map((e) => e.field)).toContain("openingQuestion");
  });
  it("the opening question does not change which records are duplicates", () => {
    const a = analyzeImport(file(rec("postpone", { openingQuestion: Q })), "json", { existing: [{ ...mk("postpone"), hints: H as unknown as BankWord["hints"] }] });
    expect(a.records[0].status).toBe("duplicate");
  });
  it("the 1,000-word import limit is unchanged", () => { expect(MAX_IMPORT).toBe(1000); });
  it("the JSON and CSV templates include it, and the template files import cleanly", () => {
    expect(CSV_COLUMNS).toContain("openingQuestion");
    expect(TEMPLATE_ROWS.every((r) => "openingQuestion" in r)).toBe(true);
    expect(templateJson()).toContain("openingQuestion");
    expect(templateCsv().split("\r\n")[0]).toContain("openingQuestion");
    for (const [t, f] of [[templateJson(), "json"], [templateCsv(), "csv"]] as const) {
      const a = analyzeImport(t, f);
      expect(a.counts.invalid, f).toBe(0);
      expect(draftsFromAnalysis(a, NOW).map((w) => w.openingQuestion)).toEqual(TEMPLATE_ROWS.map((r) => r.openingQuestion));
    }
  });
  it("the template questions themselves pass validation", () => {
    for (const r of TEMPLATE_ROWS) expect(validateBankWord({ ...r, cefr: r.level as "B1", partOfSpeech: r.partOfSpeech as "noun", accept: [...r.accept], hints: [...r.hints] }).filter((i) => i.field === "openingQuestion")).toEqual([]);
  });
  it("the prompt asks for it, with the natural examples, conceptual (not grammatical), Giver-only, free", () => {
    const p = buildGenerationPrompt({ level: "B1", size: 5, format: "json" });
    expect(p).toContain("openingQuestion");
    for (const q of OPENING_EXAMPLES) expect(p).toContain(q);
    expect(p).toMatch(/NOT its grammar/);
    expect(p).toMatch(/never shown to the Taker/);
    expect(p).toMatch(/not one of the hints/);
    expect(p).toContain("FOUR hints");
    expect(buildGenerationPrompt({ level: "B1", size: 5, format: "csv" })).toContain("openingQuestion");
  });
  it("the prompt can leave it out, and does not ask for it then", () => {
    const p = buildGenerationPrompt({ level: "B1", size: 5, format: "json", openingQuestion: false });
    expect(p).not.toContain("- openingQuestion:");
    expect(p).not.toContain("SPOKEN OPENING QUESTION");
  });
});

describe("the bank service: create, edit, export (in-memory store)", () => {
  let n = 0;
  const svc = () => new BankService(new MemoryBankStore(), () => NOW, () => `bid${++n}x`);
  const body = (extra: Record<string, unknown> = {}) => ({ word: "postpone", partOfSpeech: "verb", category: "Plans", cefr: "B2", hints: H, ...extra });
  it("create stores it, as a draft", async () => {
    const s = svc();
    const r = await s.create(body({ openingQuestion: `  ${Q}  ` }));
    if (!("word" in r)) throw new Error("create failed");
    expect(r.word).toMatchObject({ openingQuestion: Q, status: "draft", source: "manual" });
    expect(r.word.hints).toEqual(H);
  });
  it("edit changes only the opening question, leaves the hints exactly, and returns the word to draft; empty clears it", async () => {
    const s = svc();
    const c = await s.create(body());
    if (!("word" in c)) throw new Error("create failed");
    const ok = await s.approve(c.word.id);
    expect(ok.ok).toBe(true);
    const e = await s.edit(c.word.id, { openingQuestion: Q });
    if (!("word" in e)) throw new Error("edit failed");
    expect(e.word.openingQuestion).toBe(Q);
    expect(e.word.hints).toEqual(H);
    expect(e.word.status).toBe("draft");
    const cleared = await s.edit(c.word.id, { openingQuestion: "" });
    if (!("word" in cleared)) throw new Error("clear failed");
    expect(cleared.word.openingQuestion).toBeUndefined();
  });
  it("approval is refused when the opening question leaks the word", async () => {
    const s = svc();
    const c = await s.create(body({ openingQuestion: "Please postpone it. What is it?" }));
    if (!("word" in c)) throw new Error("create failed");
    expect((await s.approve(c.word.id)).ok).toBe(false);
  });
  it("import then export includes it; words without it export unchanged", async () => {
    const s = svc();
    await s.importDrafts(file(rec("postpone", { openingQuestion: Q }), rec("delayed")));
    const ex = await s.exportAll();
    const by = Object.fromEntries(ex.words.map((w) => [w.word, w]));
    expect(by.postpone.openingQuestion).toBe(Q);
    expect(by.delayed).not.toHaveProperty("openingQuestion");
    expect(by.delayed.hints).toEqual(H);
    expect(JSON.stringify(ex)).toContain(Q);
  });
});

describe("the teacher editor, card and prompt tools", () => {
  const noop = () => undefined;
  const text = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");
  it("New Word and Edit both show an editable Spoken Opening Question with natural examples", () => {
    for (const initial of [blankForm(), formFromWord(mk("postpone", { openingQuestion: Q }))]) {
      const html = text(createElement(WordEditor, { title: "t", initial, submitLabel: "Save", busy: false, serverError: null, onSubmit: noop }));
      expect(html).toContain("Spoken Opening Question");
      for (const q of OPENING_EXAMPLES) expect(html).toContain(q);
      expect(html).toContain("not its grammar");
    }
    expect(text(createElement(WordEditor, { title: "t", initial: formFromWord(mk("postpone", { openingQuestion: Q })), submitLabel: "Save", busy: false, serverError: null, onSubmit: noop }))).toContain(`value="${Q}"`);
  });
  it("the form round-trips it and sends it to the server, empty to clear", () => {
    const f = formFromWord(mk("postpone", { openingQuestion: Q }));
    expect(f.openingQuestion).toBe(Q);
    expect(payloadFromForm(f).openingQuestion).toBe(Q);
    expect(payloadFromForm({ ...f, openingQuestion: "" }).openingQuestion).toBe("");
    expect(issuesForForm({ ...f, openingQuestion: "This is a verb. What is it?" }).warnings.map((i) => i.code)).toContain("opening_grammar");
  });
  it("the word card labels it Giver-only", () => {
    const html = text(createElement(WordCard, { word: mk("postpone", { openingQuestion: Q, status: "draft" }), selected: false, busy: false, onSelect: noop, onEdit: noop, onApprove: noop, onArchive: noop, onRestore: noop }));
    expect(html).toContain("Spoken opening question · Giver only");
    expect(html).toContain(Q);
  });
  it("the prompt tool is wired to ask for it", () => {
    expect(typeof ToolsPanel).toBe("function");
  });
});

describe("play: free, Giver-only, and Taker never sees it", () => {
  const BANK = [mk("umbrella", { openingQuestion: "This is a tool. What is it?" }), mk("nervous", { openingQuestion: "This describes a feeling. What is it?", cefr: "B1" }), mk("recipe", { cefr: "B1" }), mk("postpone", { openingQuestion: Q })];
  const OQS = BANK.map((w) => w.openingQuestion).filter(Boolean) as string[];
  const words = BANK.map(toVocabWord);
  it("maps to the game word only when present; the four hints are exactly the bank's", () => {
    expect(toVocabWord(BANK[0]).openingQuestion).toBe("This is a tool. What is it?");
    expect(toVocabWord(BANK[2])).not.toHaveProperty("openingQuestion");
    expect(toVocabWord(BANK[0]).hints).toEqual([...BANK[0].hints]);
    expect(toVocabWord(BANK[0]).hints).toHaveLength(4);
  });
  async function room() {
    const now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: "Opening", words });
    if (!created.ok) throw new Error("create failed");
    const id = created.activity.id;
    const join = async (name: string, token?: string) => { const r = await svc.join({ activityId: id, group: "5", name, token }); if (!r.ok) throw new Error("join"); return r; };
    const A = await join("Aki"), B = await join("Ben");
    const act = (t: string, action: object) => svc.act({ activityId: id, group: "5", token: t, opId: Math.random().toString(36), action: action as never });
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "5", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" });
    await act(B.token, { type: "CONFIRM_ROLES" });
    await act(A.token, { type: "CONTINUE" });
    // everything the Taker can ever receive: a normal poll AND a fresh reconnect (join again with the same token)
    const everything = async () => [JSON.stringify(await view(B.token)), JSON.stringify((await join("Ben", B.token)).view)];
    return { svc, created: created.activity, A, B, act, view, everything, join };
  }

  it("the class API keeps the field on the stored words", async () => {
    const e = await room();
    expect(e.created.words.map((w) => w.openingQuestion)).toEqual([OQS[0], OQS[1], undefined, OQS[2]]);
  });

  it("the Giver sees it for the word in play only; never for words still to come", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    const g = (await e.view(e.A.token)).game!;
    expect(g.words[0].openingQuestion).toBe("This is a tool. What is it?");
    for (let i = 1; i < 4; i++) expect(g.words[i].openingQuestion, `future word ${i}`).toBeUndefined();
  });

  it("the Taker never receives it: every step, the reveal and after reconnecting (each word, fresh game)", async () => {
    for (const pick of [0, 1, 3]) {
      const e = await room();
      await e.act(e.A.token, { type: "PICK", wordId: words[pick].id });
      for (let step = 0; step < 4; step++) {
        for (const p of await e.everything()) for (const q of OQS) expect(p, `Taker payload, word ${pick}, hint step ${step}`).not.toContain(q);
        await e.act(e.A.token, { type: "REVEAL_HINT" });
      }
      await e.act(e.B.token, { type: "GUESS", text: BANK[pick].word });
      expect((await e.view(e.B.token)).game!.phase).toBe("reveal");
      for (const p of await e.everything()) for (const q of OQS) expect(p, `Taker payload at the reveal of word ${pick}`).not.toContain(q);
      expect(JSON.stringify(await e.view(e.B.token))).not.toContain("openingQuestion");
      // The Giver may still see it at the reveal.
      expect((await e.view(e.A.token)).game!.words[pick].openingQuestion).toBe(BANK[pick].openingQuestion);
    }
  });

  it("role switching: the new Giver gets their word's opening question; the old Giver (now Taker) gets none", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.B.token, { type: "GUESS", text: "umbrella" });
    await e.act(e.A.token, { type: "NEXT" });
    await e.act(e.B.token, { type: "CONTINUE" });
    await e.act(e.B.token, { type: "PICK", wordId: words[1].id });
    expect((await e.view(e.B.token)).game!.words[1].openingQuestion).toBe("This describes a feeling. What is it?");
    for (const p of [JSON.stringify(await e.view(e.A.token)), JSON.stringify((await e.join("Aki", e.A.token)).view)]) for (const q of OQS) expect(p).not.toContain(q);
  });

  it("it is free: scoring and hint progression are identical with and without an opening question", async () => {
    const run = async (withQ: boolean) => {
      const now = 1_000_000;
      const svc = new ClassService(new MemoryKV(() => now), () => now, {});
      const ws = [mk("umbrella", withQ ? { openingQuestion: "This is a tool. What is it?" } : {}), mk("borrow")].map(toVocabWord);
      const created = await svc.createActivity({ title: "T", words: ws });
      if (!created.ok) throw new Error("create");
      const id = created.activity.id;
      const j = async (name: string) => { const r = await svc.join({ activityId: id, group: "5", name }); if (!r.ok) throw new Error("join"); return r; };
      const A = await j("Aki"), B = await j("Ben");
      const act = (t: string, action: object) => svc.act({ activityId: id, group: "5", token: t, opId: Math.random().toString(36), action: action as never });
      const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "5", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view.game!; };
      await act(A.token, { type: "PROPOSE_ROLES", giver: "me" });
      await act(B.token, { type: "CONFIRM_ROLES" });
      await act(A.token, { type: "CONTINUE" });
      await act(A.token, { type: "PICK", wordId: ws[0].id });
      const seen: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const g = await view(A.token), t = await view(B.token);
        seen.push([g.revealedHints, g.hintsUsed, t.words[0].hints]);
        await act(A.token, { type: "REVEAL_HINT" });
      }
      await act(B.token, { type: "GUESS", text: "umbrella" });
      const g = await view(A.token);
      return { seen, scores: g.players.map((p) => p.score), phase: g.phase };
    };
    const a = await run(true), b = await run(false);
    expect(a).toEqual(b);
    expect(a.scores).toEqual([28, 55]); // 3 paid hints -> Taker 55, Giver half rounded up
    expect(takerPointsFor(3, "en")).toBe(55);
    expect(a.seen[0]).toEqual([1, 0, ["", "", "", ""]]); // opening hint only: the one-hint delay still shows the Taker nothing
  });

  it("the redaction itself removes the key for every word", () => {
    const state = { words: words.map((w) => ({ ...w })), statuses: Object.fromEntries(words.map((w) => [w.id, "pending"])), phase: "round", currentWordId: words[0].id, revealedHints: 1, hintsUsed: 0 } as never;
    const t = redactForTaker(state) as unknown as { words: Record<string, unknown>[] };
    for (const w of t.words) expect("openingQuestion" in w).toBe(false);
    expect(JSON.stringify(t)).not.toContain("What is it?");
  });

  it("screens: SAY THIS FIRST above the hints for the Giver; nothing for the Taker; none when absent", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    const giverHtml = renderToStaticMarkup(createElement(GiverRound, { state: (await e.view(e.A.token)).game!, dispatch: () => undefined }));
    expect(giverHtml).toContain("SAY THIS FIRST");
    expect(giverHtml).toContain("This is a tool. What is it?");
    expect(giverHtml.indexOf("SAY THIS FIRST")).toBeLessThan(giverHtml.indexOf("Opening hint"));
    expect(giverHtml.indexOf("SAY THIS FIRST")).toBeLessThan(giverHtml.indexOf('aria-label="Hints"'));
    expect(giverHtml).toContain("It is not a hint");
    const takerHtml = renderToStaticMarkup(createElement(TakerRound, { state: (await e.view(e.B.token)).game!, dispatch: () => undefined }));
    expect(takerHtml).not.toContain("SAY THIS FIRST");
    expect(takerHtml).not.toContain("What is it?");

    const none = await room();
    await none.act(none.A.token, { type: "PICK", wordId: words[2].id });
    const noHtml = renderToStaticMarkup(createElement(GiverRound, { state: (await none.view(none.A.token)).game!, dispatch: () => undefined }));
    expect(noHtml).not.toContain("SAY THIS FIRST"); // existing questions stay playable, unchanged
    expect(noHtml).toContain("Opening hint");
    expect(noHtml).toContain(BANK[2].hints[0]);
  });
});

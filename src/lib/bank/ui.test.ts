import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImportPanel } from "@/components/wordbank/ImportPanel";
import { IssueLists } from "@/components/wordbank/Issues";
import { HintList } from "@/components/wordbank/HintList";
import { ToolsPanel } from "@/components/wordbank/ToolsPanel";
import { WordCard } from "@/components/wordbank/WordCard";
import { WordEditor } from "@/components/wordbank/WordEditor";
import { makeApi } from "./client";
import type { BankWord } from "./types";
import { DEFAULT_FILTERS, HINT_ROLES, blankForm, canApprove, categoriesOf, filterWords, formFromWord, issuesForForm, levelsOf, parseAccept, payloadFromForm, splitIssues, workflowSummary } from "./view";

const NOW = "2026-11-14T00:00:00.000Z";
const H = ["You use this in the kitchen after you boil something.", "It is a bowl with a lot of small holes in it.", "The water goes out but the food stays inside the bowl.", "You pour boiled pasta into it to take the water away."];
const w = (over: Partial<BankWord> = {}): BankWord => ({ id: "b1", word: "colander", accept: ["strainer"], partOfSpeech: "noun", category: "Kitchen tools", cefr: "B1", hints: H as unknown as BankWord["hints"], status: "draft", source: "file", createdAt: NOW, updatedAt: NOW, ...over });
const html = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");
const noop = () => undefined;
const card = (word: BankWord, selected = false) => html(createElement(WordCard, { word, selected, busy: false, onSelect: noop, onEdit: noop, onApprove: noop, onArchive: noop, onRestore: noop }));

describe("hints and issues display", () => {
  it("lists the four hints in play order, least to most helpful", () => {
    const out = html(createElement(HintList, { hints: H }));
    const pos = HINT_ROLES.map((r) => out.indexOf(r.title));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    H.forEach((h, i) => expect(out.indexOf(h.replace(/'/g, "&#x27;"))).toBeGreaterThan(i ? out.indexOf(H[i - 1]) : -1));
    expect(out).toContain("Opening");
    expect(out).toContain("Most helpful");
  });
  it("shows an empty hint as empty rather than hiding it", () => {
    expect(html(createElement(HintList, { hints: ["a b c d e", "", "", ""] }))).toContain("(empty)");
  });
  it("keeps errors and teacher-review warnings in separate blocks", () => {
    const out = html(createElement(IssueLists, { errors: [{ severity: "error", code: "leak", field: "hints", message: "Hint 2 contains the answer." }], warnings: [{ severity: "warning", code: "too_short", field: "hints", message: "Hint 3 is very short." }] }));
    expect(out).toContain("Must fix before approval");
    expect(out).toContain("does not block approval");
    expect(out.indexOf("Hint 2 contains the answer")).toBeLessThan(out.indexOf("does not block approval"));
    expect(out.indexOf("Hint 3 is very short")).toBeGreaterThan(out.indexOf("does not block approval"));
    expect(html(createElement(IssueLists, { errors: [], warnings: [] }))).toBe("");
    expect(html(createElement(IssueLists, { errors: [], warnings: [{ severity: "warning", code: "x", field: "hints", message: "Just a note." }] }))).not.toContain("Must fix");
  });
  it("splitIssues separates errors from warnings", () => {
    const s = splitIssues([{ severity: "error", code: "a", field: "word", message: "x" }, { severity: "warning", code: "b", field: "word", message: "y" }]);
    expect([s.errors.length, s.warnings.length]).toEqual([1, 1]);
  });
  it("splits validation results by severity", () => {
    const s = issuesForForm({ ...formFromWord(w()), giverJa: "strainer" });
    expect(s.errors).toEqual([]);
    expect(s.warnings.map((i) => i.code)).toContain("giverja_not_japanese");
  });
});

describe("word card", () => {
  it("shows level, status, accepted answers, source, and the Giver-only Japanese meaning", () => {
    const out = card(w({ giverJa: "水切りざる", source: "classroom-quiz-show", sourceId: "cqs-9" }));
    for (const t of ["colander", "B1", "Draft", "Also accepted: strainer", "水切りざる", "Giver only", "From Classroom Quiz Show", "cqs-9"]) expect(out).toContain(t);
    expect(card(w())).not.toContain("Giver only");
  });
  it("a draft with a leak shows an error block and a disabled Approve button", () => {
    const bad = w({ hints: [H[0], "A colander has holes.", H[2], H[3]] as unknown as BankWord["hints"] });
    const out = card(bad);
    expect(out).toContain("Must fix before approval");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(canApprove(bad)).toBe(false);
  });
  it("a clean draft can be approved; approved and archived words offer the right actions", () => {
    expect(canApprove(w())).toBe(true);
    expect(card(w())).toMatch(/<button(?![^>]*disabled)[^>]*>Approve<\/button>/);
    const approved = card(w({ status: "approved" }));
    expect(approved).toContain("Approved");
    expect(approved).not.toMatch(/>Approve<\/button>/);
    expect(approved).not.toContain('type="checkbox"');
    const arch = card(w({ status: "archived" }));
    expect(arch).toContain("Restore as draft");
    expect(arch).not.toContain(">Edit<");
    expect(canApprove(w({ status: "approved" }))).toBe(false);
  });
});

describe("editor", () => {
  const render = (initial = blankForm(), extra: { note?: string; serverError?: string | null } = {}) => html(createElement(WordEditor, { title: "New word", initial, submitLabel: "Save as draft", busy: false, serverError: extra.serverError ?? null, note: extra.note, onSubmit: noop }));
  it("has every field, four hint boxes in order, and the optional Japanese meaning for the Giver", () => {
    const out = render();
    for (const t of ["Target word", "Also accepted", "Part of speech", "CEFR level", "Category", "Topic (optional)", "Japanese meaning (optional · shown to the Giver only)", "Four hints — from least to most helpful"]) expect(out).toContain(t);
    expect((out.match(/<textarea/g) ?? []).length).toBeGreaterThanOrEqual(4);
    const pos = HINT_ROLES.map((r) => out.indexOf(r.title));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(out).toContain("nothing is approved automatically");
  });
  it("shows live problems for a filled-in form, errors apart from warnings", () => {
    const f = { ...formFromWord(w()), hints: ["It is a kitchen tool.", "A colander has holes.", H[2], H[3]] };
    const out = render(f);
    expect(out).toContain("Must fix before approval");
    expect(out).toContain("does not block approval");
  });
  it("shows a server error and a note", () => {
    const out = render(blankForm(), { serverError: "An identical word is already in the bank.", note: "Write it yourself" });
    expect(out).toContain("An identical word is already in the bank.");
    expect(out).toContain("Write it yourself");
  });
});

describe("panels render without calling the server", () => {
  const fetchImpl = vi.fn();
  const api = makeApi({ fetchImpl: fetchImpl as unknown as typeof fetch });
  it("import panel explains drafts and offers preview before import", () => {
    const out = html(createElement(ImportPanel, { api, onImported: noop }));
    expect(out).toContain("always start as");
    expect(out).toContain("drafts");
    expect(out).toContain("Preview and check");
    expect(out).not.toContain("Import 0");
  });
  it("tools panel offers templates, the prompt (no AI), and the complete export", () => {
    const out = html(createElement(ToolsPanel, { api, words: [w()] }));
    for (const t of ["Download JSON template", "Download CSV template", "Copy prompt", "Export complete bank", "does not call any AI", "FOUR hints", "colander"]) expect(out).toContain(t);
    expect(out).toContain("Ask for a Japanese meaning for the Giver");
  });
  it("nothing was fetched while rendering", () => expect(fetchImpl).not.toHaveBeenCalled());
});

describe("view helpers", () => {
  const list = [w({ id: "1", word: "colander", cefr: "B1" }), w({ id: "2", word: "kettle", cefr: "A2", category: "Home", status: "approved", giverJa: "やかん" }), w({ id: "3", word: "toaster", cefr: "A2", category: "Home", status: "archived" })];
  it("filters by status, level, category and search (including accepted answers and Japanese)", () => {
    expect(filterWords(list, DEFAULT_FILTERS).map((x) => x.id)).toEqual(["1"]);
    expect(filterWords(list, { ...DEFAULT_FILTERS, status: "all" })).toHaveLength(3);
    expect(filterWords(list, { ...DEFAULT_FILTERS, status: "all", cefr: "A2" }).map((x) => x.id)).toEqual(["2", "3"]);
    expect(filterWords(list, { ...DEFAULT_FILTERS, status: "all", category: "Home" })).toHaveLength(2);
    expect(filterWords(list, { ...DEFAULT_FILTERS, status: "all", q: "STRAINER" }).map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(filterWords(list, { ...DEFAULT_FILTERS, status: "all", q: "やかん" }).map((x) => x.id)).toEqual(["2"]);
    expect(categoriesOf(list)).toEqual(["Home", "Kitchen tools"]);
    expect(levelsOf(list)).toEqual(["A2", "B1"]);
  });
  it("describes the workflow with live counts", () => {
    const s = workflowSummary({ draft: 3, approved: 5, archived: 1, total: 9 });
    expect(s.map((x) => x.step)).toEqual(["1 Import", "2 Review", "3 Edit", "4 Approve"]);
    expect(s[1].text).toContain("3 drafts");
    expect(s[3].text).toContain("5 approved");
    expect(workflowSummary({ draft: 1, approved: 0, archived: 0, total: 1 })[1].text).toContain("1 draft ");
  });
  it("turns a form into the request the server expects", () => {
    expect(parseAccept("colour; color\n  tint ;")).toEqual(["colour", "color", "tint"]);
    const f = { ...blankForm(), word: "kettle", accept: "tea kettle", category: "Home", giverJa: "やかん", hints: H };
    expect(payloadFromForm(f)).toMatchObject({ word: "kettle", accept: ["tea kettle"], giverJa: "やかん", hints: H, cefr: "A2", partOfSpeech: "noun" });
    expect(formFromWord(w()).accept).toBe("strainer");
    expect(formFromWord(w({ hints: ["a", "b", "c", "d"] as unknown as BankWord["hints"] })).hints).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the screens stay out of gameplay, sync and AI", () => {
  const files = [
    ...readdirSync(new URL("../../components/wordbank/", import.meta.url)).map((f) => new URL(`../../components/wordbank/${f}`, import.meta.url)),
    new URL("./client.ts", import.meta.url), new URL("./view.ts", import.meta.url), new URL("../../app/wordbank/page.tsx", import.meta.url),
  ];
  it("never touches class links, CQS sync, Studio AI, the browser bank or OpenAI", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const bad of ["/api/class", "/api/bank/sync", "/api/studio", "cqsSync", "cqsBank", "createClassLink", "OPENAI", "localStorage", "studio/storage", "lib/game", "lib/scoring"]) expect(src, `${f.pathname} mentions ${bad}`).not.toContain(bad);
    }
  });
});

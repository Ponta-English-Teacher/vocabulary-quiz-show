import { describe, expect, it } from "vitest";
import { MAX_IMPORT, analyzeImport, detectFormat, draftsFromAnalysis, parseCsv } from "./import";
import { approveWord, archiveWord, editWord, playableWords, restoreWord } from "./status";
import { CSV_COLUMNS, buildGenerationPrompt, templateCsv, templateFile, templateJson } from "./template";
import { BANK_FORMAT, type BankWord } from "./types";
import { errorsOf, findDuplicateWords, validateBankWord, warningsOf, type BankDraft } from "./validate";

const good = (over: Partial<BankDraft> = {}): BankDraft => ({
  word: "colander",
  accept: ["strainer"],
  partOfSpeech: "noun",
  category: "Kitchen tools",
  cefr: "B1",
  hints: ["You use this in the kitchen after you boil something.", "It is a bowl with a lot of small holes in it.", "The water goes out through the holes, but the food stays.", "You pour boiled pasta into it to take the water away."],
  ...over,
});
const codes = (w: BankDraft) => validateBankWord(w).map((i) => `${i.severity}:${i.code}`);
const NOW = "2026-11-14T00:00:00.000Z";
const bankWord = (over: Partial<BankWord> = {}): BankWord => ({ ...(good() as BankDraft), accept: ["strainer"], hints: good().hints as unknown as BankWord["hints"], id: "b1", status: "draft", source: "file", createdAt: NOW, updatedAt: NOW, ...over } as BankWord);

describe("validation", () => {
  it("accepts a good word with no errors", () => {
    expect(errorsOf(validateBankWord(good()))).toEqual([]);
  });
  it("reports every missing required field", () => {
    const c = codes({ word: "", accept: [], partOfSpeech: "" as never, category: "", cefr: "Z9" as never, hints: [] });
    expect(c).toEqual(expect.arrayContaining(["error:missing", "error:bad_pos", "error:bad_cefr", "error:hint_count"]));
  });
  it("requires exactly four hints", () => {
    expect(codes(good({ hints: good().hints.slice(0, 3) }))).toContain("error:hint_count");
    expect(codes(good({ hints: [...good().hints, "A fifth hint that is not allowed here."] }))).toContain("error:hint_count");
  });
  it("blocks answer leakage, including plurals and accepted forms", () => {
    const h = [...good().hints];
    h[1] = "A colander has holes in it.";
    expect(codes(good({ hints: h }))).toContain("error:leak");
    h[1] = "Many colanders are made of steel.";
    expect(codes(good({ hints: h }))).toContain("error:leak");
    h[1] = "Some people call it a strainer in the kitchen.";
    expect(codes(good({ hints: h }))).toContain("error:leak");
  });
  it("blocks empty, letter-only and over-long hints", () => {
    const h = [...good().hints];
    h[0] = "";
    expect(codes(good({ hints: h }))).toContain("error:empty");
    h[0] = "It starts with the letter c.";
    expect(codes(good({ hints: h }))).toContain("error:letter_only");
    h[0] = "word ".repeat(60);
    expect(codes(good({ hints: h }))).toContain("error:too_long");
  });
  it("warns about hints that are too short or too long to say aloud", () => {
    const h = [...good().hints];
    h[2] = "Has holes.";
    h[3] = "You can say this long sentence aloud but it keeps going and going with many many extra words added so that nobody can say it comfortably in one single breath at all.";
    const c = codes(good({ hints: h }));
    expect(c).toContain("warning:too_short");
    expect(c).toContain("warning:too_long_spoken");
    expect(errorsOf(validateBankWord(good({ hints: h })))).toEqual([]);
  });
  it("rejects repeated hints and warns on near-repeats", () => {
    const h = [...good().hints];
    h[2] = h[1].toUpperCase();
    expect(codes(good({ hints: h }))).toContain("error:repeated_hint");
    h[2] = "It is a bowl with lots of small holes inside it.";
    const c = codes(good({ hints: h }));
    expect(c).toContain("warning:similar_hints");
    expect(c).not.toContain("error:repeated_hint");
  });
  it("warns about vague or numeric opening hints", () => {
    expect(codes(good({ hints: ["It is a kitchen tool.", ...good().hints.slice(1)] }))).toContain("warning:vague_opening");
    expect(codes(good({ hints: ["It was invented in 1850 in Europe.", ...good().hints.slice(1)] }))).toContain("warning:numeric_opening");
  });
  it("checks the optional Japanese meaning without making it required", () => {
    expect(codes(good())).not.toContain("warning:giverja_not_japanese");
    expect(codes(good({ giverJa: "水切りざる" }))).not.toContain("warning:giverja_not_japanese");
    expect(codes(good({ giverJa: "strainer" }))).toContain("warning:giverja_not_japanese");
    expect(codes(good({ giverJa: "あ".repeat(61) }))).toContain("error:too_long");
  });
  it("rejects markup and placeholders", () => {
    const h = [...good().hints];
    h[1] = "TODO write this hint later please.";
    expect(codes(good({ hints: h }))).toContain("error:placeholder");
    h[1] = "<script>alert(1)</script> is in the bowl.";
    expect(codes(good({ hints: h }))).toContain("error:markup");
  });
  it("labels same-word groups, ignoring case, punctuation and archived words", () => {
    const h = ["a b c d e", "f g h i j", "k l m n o", "p q r s t"];
    const d = findDuplicateWords([
      { id: "1", word: "Colander", status: "draft", cefr: "B1", hints: h },
      { id: "2", word: "colander!", status: "approved", cefr: "B1", hints: h.map((x) => x.toUpperCase()) },
      { id: "3", word: "colander", status: "archived", cefr: "A1", hints: h },
      { id: "4", word: "kettle", status: "draft", cefr: "A1", hints: h },
      { id: "5", word: "oven", status: "draft", cefr: "A1", hints: h },
      { id: "6", word: "oven", status: "draft", cefr: "B2", hints: h },
      { id: "7", word: "toast", status: "draft", cefr: "A1", hints: h },
      { id: "8", word: "toast", status: "draft", cefr: "A1", hints: [...h.slice(0, 3), "different last hint here"] },
    ]);
    expect(d).toEqual([
      { word: "colander", ids: ["1", "2"], kind: "identical" },
      { word: "oven", ids: ["5", "6"], kind: "different_level" },
      { word: "toast", ids: ["7", "8"], kind: "different_hints" },
    ]);
  });
});

describe("status: draft / approved / archived", () => {
  it("approves only a valid draft", () => {
    const ok = approveWord(bankWord(), NOW);
    expect(ok.ok && ok.word.status).toBe("approved");
    const bad = approveWord(bankWord({ hints: ["", "", "", ""] as never }), NOW);
    expect(bad.ok).toBe(false);
  });
  it("editing an approved word returns it to draft", () => {
    const a = approveWord(bankWord(), NOW);
    if (!a.ok) throw new Error("expected approval");
    const e = editWord(a.word, { category: "Cooking" }, "2026-11-15");
    expect(e.status).toBe("draft");
    expect(e.approvedAt).toBeUndefined();
  });
  it("archive and restore: restore never re-approves", () => {
    const a = approveWord(bankWord(), NOW);
    if (!a.ok) throw new Error("expected approval");
    const arch = archiveWord(a.word, NOW);
    expect(arch.status).toBe("archived");
    expect(arch.archivedFrom).toBe("approved");
    expect(approveWord(arch, NOW).ok).toBe(false);
    const back = restoreWord(arch, NOW);
    expect(back.status).toBe("draft");
    expect(back.archivedFrom).toBeUndefined();
  });
  it("only approved words are playable", () => {
    const a = approveWord(bankWord({ id: "a" }), NOW);
    if (!a.ok) throw new Error("expected approval");
    const list = [a.word, bankWord({ id: "d" }), archiveWord(bankWord({ id: "x" }), NOW)];
    expect(playableWords(list).map((w) => w.id)).toEqual(["a"]);
  });
});

describe("parsing", () => {
  it("detects the format", () => {
    expect(detectFormat("[]", "x.json")).toBe("json");
    expect(detectFormat("a,b", "x.csv")).toBe("csv");
    expect(detectFormat('{"words":[]}')).toBe("json");
    expect(detectFormat("word,x")).toBe("csv");
  });
  it("reads quoted CSV cells, doubled quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    expect(() => parseCsv('a,"b')).toThrow(/never closed/);
  });
  it("reports file-level problems", () => {
    expect(analyzeImport("", "json").fileErrors[0]).toMatch(/empty/);
    expect(analyzeImport("{oops", "json").fileErrors[0]).toMatch(/not valid JSON/);
    expect(analyzeImport('{"words": 3}', "json").fileErrors[0]).toMatch(/list of words/);
    expect(analyzeImport('{"format":"classroom-quiz-show/questions","questions":[]}', "json").fileErrors[0]).toMatch(/not a Vocabulary Quiz Show/);
    expect(analyzeImport("word,category\nx,y", "csv").fileErrors[0]).toMatch(/missing these columns/);
  });
});

describe("import preview", () => {
  const rec = (over: Record<string, unknown> = {}) => ({ word: "kettle", partOfSpeech: "noun", category: "Kitchen", level: "A2", hints: ["You use this every morning to make tea.", "It has a handle and a spout on one side.", "You fill it with water and heat it up.", "It boils water for tea and coffee."], ...over });
  const json = (...r: object[]) => JSON.stringify({ format: BANK_FORMAT, words: r });

  it("marks good records valid and counts them", () => {
    const a = analyzeImport(json(rec()), "json");
    expect(a.counts).toMatchObject({ total: 1, valid: 1, importable: 1, invalid: 0 });
  });
  it("accepts flat hint1..hint4 and string lists", () => {
    const a = analyzeImport(json({ word: "kettle", accept: "tea kettle; water kettle", pos: "n", category: "Kitchen", cefr: "a2", hint1: "You use this every morning to make tea.", hint2: "It has a handle and a spout on one side.", hint3: "You fill it with water and heat it up.", hint4: "It boils water for tea and coffee." }), "json");
    expect(a.records[0].status).toBe("valid");
    expect(a.records[0].candidate?.accept).toEqual(["tea kettle", "water kettle"]);
    expect(a.records[0].candidate?.cefr).toBe("A2");
  });
  it("marks invalid records with reasons and never imports them", () => {
    const a = analyzeImport(json(rec({ word: "" }), rec({ word: "tea", hints: ["You drink tea every morning.", "x y z w v u", "It is a hot drink from leaves.", "Brewed in a cup."] }), rec({ level: "Z" }), 5 as never), "json");
    expect(a.records.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(a.counts.importable).toBe(0);
    expect(a.records[1].errors.map((e) => e.code)).toContain("leak");
  });
  it("flags duplicates against the bank and inside the file; archived words do not block", () => {
    const hints = rec().hints;
    const existing = [{ word: "Kettle", accept: [] as string[], status: "draft" as const, cefr: "A2", hints }, { word: "toaster", accept: [], status: "archived" as const, cefr: "A2", hints }];
    const a = analyzeImport(json(rec(), rec({ word: "toaster" }), rec({ word: "oven" }), rec({ word: "oven" })), "json", { existing });
    expect(a.records.map((r) => r.status)).toEqual(["duplicate", "valid", "valid", "duplicate"]);
    expect(a.records[0].note).toMatch(/identical record.*in the bank/);
    expect(a.records[3].note).toMatch(/row 3/);
    expect(a.counts.importable).toBe(2);
  });
  it("sends an accepted-answer clash to review instead of importing it", () => {
    const existing = [{ word: "strainer", accept: ["colander"], status: "approved" as const }];
    const a = analyzeImport(json(rec({ word: "colander", hints: ["You use this in the kitchen after you boil something.", "It is a bowl with a lot of small holes in it.", "The water goes out but the food stays inside it.", "You pour boiled pasta into it to take water away."] })), "json", { existing });
    expect(a.records[0].status).toBe("review");
    expect(a.records[0].importable).toBe(false);
  });
  it("keeps warnings importable", () => {
    const a = analyzeImport(json(rec({ giverJa: "kettle" })), "json");
    expect(a.records[0].status).toBe("warning");
    expect(a.records[0].importable).toBe(true);
  });
  it("always creates drafts with opaque ids, even if the file says approved", () => {
    const a = analyzeImport(json(rec({ status: "approved" }), rec({ word: "oven" })), "json");
    expect(a.records[0].warnings.map((w) => w.code)).toContain("status_ignored");
    const drafts = draftsFromAnalysis(a, NOW);
    expect(drafts.map((d) => d.status)).toEqual(["draft", "draft"]);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(2);
    expect(drafts.every((d) => !d.id.toLowerCase().includes("kettle") && !d.id.toLowerCase().includes("oven"))).toBe(true);
    expect(drafts[0].hints).toHaveLength(4);
  });
  it("previews at least 1,000 records (the 518-question backup fits), and refuses more", () => {
    expect(MAX_IMPORT).toBeGreaterThanOrEqual(1000);
    const mk = (n: number) => Array.from({ length: n }, (_, i) => rec({ word: `alpha${"abcdefghij"[i % 10]}${"klmnopqrst"[Math.floor(i / 10) % 10]}${"uvwxyzabcd"[Math.floor(i / 100) % 10]}` }));
    const a518 = analyzeImport(json(...mk(518)), "json");
    expect(a518.fileErrors).toEqual([]);
    expect(a518.counts.total).toBe(518);
    expect(analyzeImport(json(...mk(1000)), "json").fileErrors).toEqual([]);
    expect(analyzeImport(json(...mk(1001)), "json").fileErrors[0]).toMatch(/1000/);
  });
});

describe("template and prompt", () => {
  it("the JSON template imports cleanly with no errors", () => {
    const a = analyzeImport(templateJson(), "json");
    expect(a.fileErrors).toEqual([]);
    expect(a.records.map((r) => r.status).every((s) => s === "valid")).toBe(true);
    expect(a.records.flatMap((r) => errorsOf([...r.errors, ...r.warnings]))).toEqual([]);
  });
  it("the CSV template imports cleanly and matches its columns", () => {
    const a = analyzeImport(templateCsv(), "csv");
    expect(a.fileErrors).toEqual([]);
    expect(a.counts.importable).toBe(2);
    expect(a.records[0].candidate?.accept).toEqual(["strainer"]);
    expect(a.records[0].candidate?.giverJa).toBe("水切りざる");
    expect(templateCsv().split("\r\n")[0].split(",")).toEqual([...CSV_COLUMNS]);
    expect(analyzeImport(templateFile("csv").content, "csv").counts.importable).toBe(2); // BOM-safe
  });
  it("template hints produce no warnings either", () => {
    expect(warningsOf(analyzeImport(templateJson(), "json").records.flatMap((r) => r.warnings))).toEqual([]);
  });
  it("the prompt states the oral four-hint rules, level and avoid list", () => {
    const p = buildGenerationPrompt({ level: "B1", topic: "Kitchen tools", size: 20, format: "json", existingWords: ["kettle", "oven"] });
    for (const t of ["FOUR hints", "LEAST helpful", "MOST helpful", "NEVER write the target word", "giverJa", "Write 20 words", '"Kitchen tools"', "CEFR level B1", "kettle, oven", "starts as a draft", "ONLY a JSON array"]) expect(p).toContain(t);
  });
  it("the prompt can drop the Japanese field and switch to CSV", () => {
    const p = buildGenerationPrompt({ level: "Mixed", size: 5, format: "csv", giverJa: false });
    expect(p).not.toContain("- giverJa:");
    expect(p).toContain("ONLY CSV");
    expect(p).toContain("Spread the words across CEFR levels");
  });
  it("prompt-style output round-trips through the importer", () => {
    const example = buildGenerationPrompt({ level: "A2", size: 1, format: "json" }).split("required format:\n")[1];
    const a = analyzeImport(`[${example}]`, "json");
    expect(a.fileErrors).toEqual([]);
    expect(a.counts.importable).toBe(1);
  });
});

describe("same-word handling", () => {
  const H = ["You use this every morning to make tea.", "It has a handle and a spout on one side.", "You fill it with water and heat it up.", "It boils water for tea and coffee."];
  const H2 = ["People in Britain use this many times each day.", "It makes a loud whistling sound when it is ready.", "You put it on the stove or plug it into the wall.", "It is a container that boils water."];
  const rec = (over: Record<string, unknown> = {}) => ({ word: "kettle", partOfSpeech: "noun", category: "Kitchen", level: "A2", hints: H, ...over });
  const json = (...r: object[]) => JSON.stringify({ format: BANK_FORMAT, words: r });
  const inBank = (over: Record<string, unknown> = {}) => ({ word: "kettle", accept: [] as string[], status: "approved" as const, cefr: "A2", hints: H, ...over });

  it("rejects a genuinely identical record (bank or file), ignoring case and punctuation", () => {
    const a = analyzeImport(json(rec({ hints: H.map((h) => h.toUpperCase().replace(".", "!")) })), "json", { existing: [inBank()] });
    expect(a.records[0].status).toBe("duplicate");
    expect(a.records[0].importable).toBe(false);
    expect(a.records[0].needsDecision).toBeFalsy();
    const f = analyzeImport(json(rec(), rec()), "json");
    expect(f.records.map((r) => r.status)).toEqual(["valid", "duplicate"]);
    expect(f.records[1].note).toMatch(/row 1/);
  });
  it("identical stays rejected even if only the accepted answers or the Japanese differ", () => {
    const a = analyzeImport(json(rec({ accept: ["tea kettle"], giverJa: "やかん" })), "json", { existing: [inBank()] });
    expect(a.records[0].status).toBe("duplicate");
  });
  it("flags the same word at a different CEFR level for review, not rejection", () => {
    const a = analyzeImport(json(rec({ level: "B2" })), "json", { existing: [inBank()] });
    expect(a.records[0].status).toBe("review");
    expect(a.records[0].needsDecision).toBe(true);
    expect(a.records[0].note).toMatch(/different CEFR level/);
    const f = analyzeImport(json(rec(), rec({ level: "C1" })), "json");
    expect(f.records.map((r) => r.status)).toEqual(["valid", "review"]);
  });
  it("flags different hints at the same level for review as well", () => {
    const a = analyzeImport(json(rec({ hints: H2 })), "json", { existing: [inBank()] });
    expect(a.records[0].status).toBe("review");
    expect(a.records[0].note).toMatch(/different hints/);
  });
  it("imports a review record as a draft only when the teacher keeps it", () => {
    const a = analyzeImport(json(rec({ level: "B2" }), rec({ word: "oven" })), "json", { existing: [inBank()] });
    expect(draftsFromAnalysis(a, NOW).map((d) => d.word)).toEqual(["oven"]);
    const kept = draftsFromAnalysis(a, NOW, undefined, new Set([1]));
    expect(kept.map((d) => `${d.word}:${d.cefr}:${d.status}`)).toEqual(["kettle:B2:draft", "oven:A2:draft"]);
  });
  it("a kept different-hints word can then be approved alongside the original", () => {
    const a = analyzeImport(json(rec({ hints: H2 })), "json", { existing: [inBank()] });
    const [d] = draftsFromAnalysis(a, NOW, () => "new1", new Set([1]));
    const original = { ...bankWord({ id: "orig", word: "kettle", accept: [], cefr: "A2" }), hints: H as unknown as BankWord["hints"], status: "approved" as const };
    const ok = approveWord(d, NOW, [original]);
    expect(ok.ok).toBe(true);
  });
  it("refuses to approve a word identical to one already in the bank", () => {
    const original = { ...bankWord({ id: "orig", word: "kettle", accept: [], cefr: "A2" }), hints: H as unknown as BankWord["hints"], status: "approved" as const };
    const twin = { ...original, id: "twin", status: "draft" as const };
    const r = approveWord(twin, NOW, [original]);
    expect(r.ok).toBe(false);
    expect(approveWord(twin, NOW, [{ ...original, status: "archived" }]).ok).toBe(true);
  });
  it("keeps leakage and structure strict even for a repeated word", () => {
    const leaky = ["You use this every morning to make tea.", "A kettle has a handle and a spout.", H[2], H[3]];
    const a = analyzeImport(json(rec({ level: "B2", hints: leaky }), rec({ level: "B2", hints: H.slice(0, 3) })), "json", { existing: [inBank()] });
    expect(a.records.map((r) => r.status)).toEqual(["invalid", "invalid"]);
    expect(a.records[0].errors.map((e) => e.code)).toContain("leak");
    expect(a.records[1].errors.map((e) => e.code)).toContain("hint_count");
    expect(draftsFromAnalysis(a, NOW, undefined, new Set([1, 2]))).toEqual([]);
  });
  it("never lets a duplicate be kept, even if asked", () => {
    const a = analyzeImport(json(rec()), "json", { existing: [inBank()] });
    expect(draftsFromAnalysis(a, NOW, undefined, new Set([1]))).toEqual([]);
  });
  it("archived bank words do not count as same-word", () => {
    const a = analyzeImport(json(rec()), "json", { existing: [inBank({ status: "archived" })] });
    expect(a.records[0].status).toBe("valid");
  });
});

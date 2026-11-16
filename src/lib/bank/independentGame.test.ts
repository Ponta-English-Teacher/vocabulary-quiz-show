import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BankHost } from "@/components/class/BankHost";
import { BankSourceSelect, DEFAULT_BANK_SOURCE } from "@/components/class/BankSourceSelect";
import { MemoryKV } from "@/lib/class/kv";
import { ClassService } from "@/lib/class/service";
import { takerPointsFor } from "@/lib/scoring";
import { DEFAULT_BANK_GAME_WORDS, filterPlayable, loadIndependent, pickIndependent, playableFrom, toVocabWord, unavailableMessage } from "./play";
import { approveWord } from "./status";
import type { BankWord } from "./types";
import { validateBankWord } from "./validate";

const NOW = "2026-11-14T00:00:00.000Z";
const mk = (word: string, ja: string | undefined, over: Partial<BankWord> = {}): BankWord => ({
  id: `b${word}id`, word, accept: [], partOfSpeech: "noun", category: "Home", cefr: "A2",
  hints: [`H1MARK${word} imagine a calm morning at home.`, `H2MARK${word} think about what people do there.`, `H3MARK${word} it has a clear purpose for everyone.`, `H4MARK${word} this is the most helpful clue to say.`] as unknown as BankWord["hints"],
  ...(ja ? { giverJa: ja } : {}), status: "approved", source: "file", createdAt: NOW, updatedAt: NOW, ...over,
});
// letters only, so no hint contains a word by accident
const BANK: BankWord[] = [mk("umbrella", "傘亜"), mk("borrow", "借りる亜", { accept: ["to borrow"], partOfSpeech: "verb" }), mk("nervous", "緊張亜", { cefr: "B1", category: "Feelings" }), mk("recipe", undefined, { cefr: "B1", category: "Food" }), mk("postpone", "延期亜", { cefr: "B2", category: "Plans" })];

describe("mapping a bank word to the game", () => {
  it("keeps four hints in order, accepted answers, source and the Giver-only Japanese; leaves Japanese ANSWERS empty", () => {
    const v = toVocabWord(BANK[1]);
    expect(v).toMatchObject({ id: BANK[1].id, word: "borrow", accept: ["to borrow"], cefr: "A2", category: "Home", giverJa: "借りる亜", source: "vqs-bank", sourceId: BANK[1].id, meaning: "", example: "" });
    expect(v.hints).toEqual([...BANK[1].hints]);
    expect(v.ja).toBeUndefined();
    expect(v.studyJa).toBeUndefined();
    expect(toVocabWord(BANK[3]).giverJa).toBeUndefined();
  });
  it("only approved words that still pass the checks are playable", () => {
    const bad = mk("badone", undefined, { hints: ["", "", "", ""] as unknown as BankWord["hints"] });
    const p = playableFrom([...BANK, mk("draftone", undefined, { status: "draft" }), mk("oldone", undefined, { status: "archived" }), bad]);
    expect(p.words.map((w) => w.word)).toEqual(BANK.map((w) => w.word));
    expect(p.excluded).toBe(1);
    expect(approveWord({ ...BANK[0], status: "draft" }, NOW).ok).toBe(true);
    expect(BANK.every((w) => validateBankWord(w).every((i) => i.severity !== "error"))).toBe(true);
  });
  it("filters by level and category and picks each word at most once", () => {
    expect(filterPlayable(BANK, { cefr: "B1", category: "all" }).map((w) => w.word)).toEqual(["nervous", "recipe"]);
    expect(filterPlayable(BANK, { cefr: "all", category: "Plans" }).map((w) => w.word)).toEqual(["postpone"]);
    const pick = pickIndependent([...BANK, BANK[0]], 50);
    expect(pick.words).toHaveLength(5);
    expect(new Set(pick.words.map((w) => w.id)).size).toBe(5);
    expect(pick.short).toBe(true);
    expect(pickIndependent(BANK, 3).words).toHaveLength(3);
    expect(pickIndependent(BANK, 3).short).toBe(false);
    expect(pickIndependent([], 5)).toEqual({ words: [], count: 0, short: true });
    expect(DEFAULT_BANK_GAME_WORDS).toBe(10);
  });
});

describe("unavailable or empty: a clear error and NEVER another bank", () => {
  it("a failing list request is an error result, not a fallback", async () => {
    let calls = 0;
    const r = await loadIndependent({ list: async () => { calls++; return { ok: false as const, message: "Could not reach the server." }; } });
    expect(calls).toBe(1);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/could not be loaded/);
      expect(r.message).toMatch(/other bank was not used/);
    }
  });
  it("an empty bank is ready-with-nothing, and the messages explain it", async () => {
    const r = await loadIndependent({ list: async () => ({ ok: true as const, data: { words: [mk("d", undefined, { status: "draft" })] } }) });
    expect(r.kind === "ready" && r.playable.words).toEqual([]);
    expect(unavailableMessage("empty")).toMatch(/no approved words/);
    expect(unavailableMessage("empty")).toMatch(/other bank was not used/);
    expect(unavailableMessage("nomatch")).toMatch(/No approved words/);
  });
  it("the picker never touches the current bank, sync or the browser", () => {
    const src = readFileSync(new URL("../../components/class/IndependentBankPicker.tsx", import.meta.url), "utf8");
    for (const bad of ["cqsBank", "cqsSync", "loadBank", "localStorage", "getBrowserStorage", "/api/bank/sync", "OPENAI"]) expect(src).not.toContain(bad);
    expect(src).toContain("approved");
  });
  const render = (source: "current" | "independent", currentCount: number | null = 518, independentCount: number | null = null) =>
    renderToString(createElement(BankSourceSelect, { source, currentCount, independentCount, onChange: () => undefined })).replace(/<!-- -->/g, "");
  it("the selector offers both banks, clearly labelled, with the Current Bank selected by default", () => {
    expect(DEFAULT_BANK_SOURCE).toBe("current");
    const html = render(DEFAULT_BANK_SOURCE);
    expect(html).toContain("Current Bank");
    expect(html).toContain("Existing questions saved in this browser (518 questions)");
    expect(html).toContain("Independent VQS Word Bank");
    expect(html).toMatch(/<input type="radio" name="bank-source" checked=""\/><span><b>Current Bank/);
    expect(html).toMatch(/<input type="radio" name="bank-source"\/><span><b>Independent VQS Word Bank/);
    expect(render("independent", 518, 5)).toContain("Approved words stored on the server (5 approved)");
    expect(render("current", 518, 5)).not.toContain("(5 approved)");
  });
  it("Manage Word Bank: always shown below the independent option, either bank selected, any word count; same tab", () => {
    for (const html of [render("current"), render("independent"), render("independent", null, 0), render("independent", 518, 600), render("current", null, null)]) {
      expect(html).toMatch(/Independent VQS Word Bank[\s\S]*<\/label><a class="btn btn--small bankhost__manage" href="\/wordbank">Manage Word Bank<\/a>/);
      expect(html.match(/href="\/wordbank"/g)).toHaveLength(1);
      expect(html).not.toContain("target=");
    }
  });
  it("no redundant or outdated Word Bank navigation remains", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    const welcome = read("../../components/Welcome.tsx");
    expect(welcome).not.toContain("/wordbank");
    expect(read("../../components/class/IndependentBankPicker.tsx")).not.toContain("/wordbank");
    for (const src of [welcome, read("../../components/wordbank/WordBankManager.tsx")]) expect(src).not.toMatch(/do not use it yet/i);
  });
  it("the start page starts on the default and shows the independent bank only when chosen", () => {
    const src = readFileSync(new URL("../../components/class/BankHost.tsx", import.meta.url), "utf8");
    expect(src).toContain("useState<BankSource>(DEFAULT_BANK_SOURCE)");
    expect(src).toMatch(/source === "independent" \?\s*\(\s*<IndependentBankPicker/);
    expect(src).not.toContain("setSource(\"independent\")"); // nothing switches to it automatically
    const html = renderToString(createElement(BankHost)).replace(/<!-- -->/g, "");
    expect(html).not.toContain("Loading approved words"); // nothing is requested from the server until the teacher chooses it
  });
});

describe("gameplay with independent-bank words (real class engine, in-memory storage)", () => {
  const words = BANK.map(toVocabWord);
  async function room() {
    const now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: "Independent", words });
    if (!created.ok) throw new Error("create failed");
    const id = created.activity.id;
    const join = async (name: string, token?: string) => { const r = await svc.join({ activityId: id, group: "5", name, token }); if (!r.ok) throw new Error("join"); return r; };
    const A = await join("Aki"), B = await join("Ben");
    const act = (t: string, action: object) => svc.act({ activityId: id, group: "5", token: t, opId: Math.random().toString(36), action: action as never });
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "5", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" });
    await act(B.token, { type: "CONFIRM_ROLES" });
    await act(A.token, { type: "CONTINUE" });
    const everything = async (token: string, name: string) => [JSON.stringify(await view(token)), JSON.stringify((await join(name, token)).view)];
    return { svc, created: created.activity, A, B, act, view, everything };
  }
  type Room = Awaited<ReturnType<typeof room>>;
  const JA = BANK.map((w) => w.giverJa).filter(Boolean) as string[];

  it("the class API accepts the words: four hints, accepted answers, source and Japanese meaning survive", async () => {
    const e = await room();
    const stored = e.created.words;
    expect(stored).toHaveLength(5);
    expect(stored[1]).toMatchObject({ word: "borrow", accept: ["to borrow"], giverJa: "借りる亜", source: "vqs-bank" });
    expect(stored.every((w) => w.hints.length === 4)).toBe(true);
    expect(stored[3].giverJa).toBeUndefined();
  });

  it("the Giver sees the Japanese meaning of the word in play ONLY; the Taker never sees any, at any stage", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    const giver = (await e.view(e.A.token)).game!;
    expect(giver.words[0].giverJa).toBe("傘亜");
    for (let i = 1; i < 5; i++) expect(giver.words[i].giverJa, `future word ${i} must not reach the Giver`).toBeUndefined();
    for (let step = 0; step < 4; step++) {
      for (const p of await e.everything(e.B.token, "Ben")) for (const ja of JA) expect(p, "Taker payload").not.toContain(ja);
      await e.act(e.A.token, { type: "REVEAL_HINT" });
    }
    await e.act(e.B.token, { type: "GUESS", text: "umbrella" });
    expect((await e.view(e.B.token)).game!.phase).toBe("reveal");
    for (const p of await e.everything(e.B.token, "Ben")) for (const ja of JA) expect(p, "Taker payload at the reveal").not.toContain(ja);
    const giverAtReveal = (await e.view(e.A.token)).game!;
    expect(giverAtReveal.words[0].giverJa).toBe("傘亜"); // the Giver may still see it
  });

  it("role switching: the new Giver gets their word's Japanese; the old Giver (now Taker) gets none", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    await e.act(e.B.token, { type: "GUESS", text: "umbrella" });
    await e.act(e.A.token, { type: "NEXT" });
    await e.act(e.B.token, { type: "CONTINUE" });
    await e.act(e.B.token, { type: "PICK", wordId: words[1].id });
    expect((await e.view(e.B.token)).game!.words[1].giverJa).toBe("借りる亜");
    for (const p of await e.everything(e.A.token, "Aki")) for (const ja of JA) expect(p).not.toContain(ja);
  });

  it("four prepared hints: the opening is free, each extra costs 15 (floor 25), and the Taker sees every revealed hint except the newest", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[0].id });
    for (let i = 0; i < 3; i++) await e.act(e.A.token, { type: "REVEAL_HINT" });
    const g = await e.view(e.A.token);
    expect(g.game!.words[0].hints).toEqual([...BANK[0].hints]);
    const taker = (await e.view(e.B.token)).game!;
    expect(taker.revealedHints).toBe(4);
    expect(taker.words[0].hints).toEqual([BANK[0].hints[0], BANK[0].hints[1], BANK[0].hints[2], ""]);
    for (const p of await e.everything(e.B.token, "Ben")) expect(p).not.toContain(BANK[0].hints[3]);
    await e.act(e.B.token, { type: "GUESS", text: "umbrella" });
    const scores = (await e.view(e.A.token)).game!.players.map((p) => p.score);
    expect(takerPointsFor(3, "en")).toBe(55);
    expect(scores).toEqual([28, 55]); // Giver gets half (rounded up), Taker 55
  });

  it("accepted answers still score, and a Japanese guess earns nothing for a word without approved Japanese answers", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[1].id });
    const before = (await e.view(e.A.token)).game!.players.map((p) => p.score);
    await e.act(e.B.token, { type: "GUESS_JA", text: "借りる亜" });
    const mid = await e.view(e.B.token);
    expect(mid.game!.players.map((p) => p.score)).toEqual(before);
    expect(mid.game!.phase).toBe("round");
    await e.act(e.B.token, { type: "GUESS", text: "to borrow" });
    expect((await e.view(e.B.token)).game!.phase).toBe("reveal");
    expect((await e.view(e.A.token)).game!.players.map((p) => p.score)).toEqual([50, 100]);
  });

  it("a word with no Japanese meaning simply shows none", async () => {
    const e = await room();
    await e.act(e.A.token, { type: "PICK", wordId: words[3].id });
    expect((await e.view(e.A.token)).game!.words[3].giverJa).toBeUndefined();
  });
});

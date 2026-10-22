import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabSet } from "@/data/vocab";
import { GiverRound } from "@/components/GiverRound";
import { TakerRound } from "@/components/TakerRound";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { createInitialState, currentWord, gameReducer, redactForTaker, type GameState } from "@/lib/game";
import { approveSet, createActivity, createSet, todaysWords } from "@/lib/studio/ops";

const todays = (): VocabSet => {
  const words = SAMPLE_SET.words.map((w, i) => ({ ...w, id: `t${i}` }));
  const a = { ...createActivity("T", "2026-05-01T00:00:00Z"), sets: [createSet(words, "Set 1")] };
  return todaysWords([approveSet(a, a.sets[0].id).activity])!;
};
const sets: [string, () => VocabSet][] = [["Preset Vocabulary", () => SAMPLE_SET], ["Today's Words", todays]];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("no in-app microphone or speech recognition", () => {
  it("the source has no SpeechRecognition, getUserMedia or recognition modules", () => {
    expect(existsSync("src/lib/dictation.ts")).toBe(false);
    expect(existsSync("src/components/useDictation.ts")).toBe(false);
    const files = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("noMicrophone.test.ts"));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/SpeechRecognition|webkitSpeechRecognition|getUserMedia|mediaDevices|useDictation|createDictation/);
    }
  });
  it("a render never creates a recognition object or asks for the microphone", () => {
    const g = globalThis as Record<string, unknown>;
    const calls: string[] = [];
    g.SpeechRecognition = g.webkitSpeechRecognition = class { constructor() { calls.push("recognition"); } };
    const nav = { mediaDevices: { getUserMedia: () => { calls.push("mic"); return Promise.reject(new Error("no")); } } };
    Object.defineProperty(g, "navigator", { value: nav, configurable: true });
    try {
      for (const mode of ["round"] as const) void mode;
      renderToStaticMarkup(h(TakerRound, { state: redactForTaker(start(SAMPLE_SET)), dispatch: () => undefined }));
    } finally {
      delete g.SpeechRecognition; delete g.webkitSpeechRecognition;
      Object.defineProperty(g, "navigator", { value: undefined, configurable: true });
    }
    expect(calls).toEqual([]);
  });
});

function start(set: VocabSet): GameState {
  const words = set.words;
  let s = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words });
  s = gameReducer(s, { type: "CONTINUE" });
  return gameReducer(s, { type: "PICK", wordId: words[0].id });
}

describe.each(sets)("typed answers — %s", (_n, make) => {
  const set = make();
  it("the Taker screen has a text box and Lock it in, no microphone button, and the Japanese entry remains", () => {
    const html = renderToStaticMarkup(h(TakerRound, { state: redactForTaker(start(set)), dispatch: () => undefined }));
    expect(html).toContain('id="answer"');
    expect(html).toContain("Lock it in");
    expect(html).toContain("I know it, but not in English!");
    expect(html).not.toMatch(/mic-btn|🎤|⏹|Speak your answer|Listening|dictation-note/);
  });
  it("demo: an English typed answer scores 100/50; a Japanese typed answer scores 50/25", () => {
    const en = gameReducer(start(set), { type: "GUESS", text: set.words[0].word });
    expect(en.players.map((p) => p.score).sort((a, b) => a - b)).toEqual([50, 100]);
    const ja = gameReducer(start(set), { type: "GUESS_JA", text: set.words[0].ja![0] });
    expect(ja.players.map((p) => p.score).sort((a, b) => a - b)).toEqual([25, 50]);
  });
  it("classroom: both players finish a whole game by typing, with a reconnect and role switches", async () => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const created = await svc.createActivity({ title: "t", words: set.words });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    const join = async (n: string, token?: string) => { const r = await svc.join({ activityId: id, group: "9", name: n, token }); if (!r.ok) throw new Error("join"); return r; };
    const A = await join("Aki"), B = await join("Ben");
    const act = (t: string, a: object) => svc.act({ activityId: id, group: "9", token: t, opId: Math.random().toString(36), action: a as never });
    const view = async (t: string) => { const r = await svc.getView({ activityId: id, group: "9", token: t }); if (!r.ok || r.unchanged) throw new Error("view"); return r.view; };
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }); await act(B.token, { type: "CONFIRM_ROLES" });
    const tokens = { a: A.token, b: B.token };
    const roles: string[] = [];
    for (let i = 0; i < set.words.length; i++) {
      const gv = await view(tokens.a);
      roles.push(gv.role!);
      const giverTok = gv.role === "giver" ? tokens.a : tokens.b;
      const takerTok = giverTok === tokens.a ? tokens.b : tokens.a;
      await act(giverTok, { type: "CONTINUE" });
      await act(giverTok, { type: "PICK", wordId: set.words[i].id });
      if (i === 1) await join("Ben", tokens.b); // reconnection mid-game
      const w = set.words[i];
      const r = i % 2 === 0 ? await act(takerTok, { type: "GUESS", text: w.word }) : await act(takerTok, { type: "GUESS_JA", text: w.ja![0] });
      expect(r.ok).toBe(true);
      const tv = await view(takerTok);
      expect(tv.game!.phase).toBe("reveal");
      expect(renderToStaticMarkup(h(TakerRound, { state: tv.game!, dispatch: () => undefined }))).not.toMatch(/mic-btn|🎤/);
      await act(takerTok, { type: "NEXT" });
    }
    expect(roles.slice(0, 4)).toEqual(["giver", "taker", "giver", "taker"]); // roles alternate
    const final = (await view(tokens.a)).game!;
    expect(final.phase).toBe("final");
    // 5 English answers (100 + 50 split) and 5 Japanese answers (50 + 25 split), however the roles fell.
    expect(final.players.reduce((n, p) => n + p.score, 0)).toBe(5 * 150 + 5 * 75);
  });
});

describe("text-to-speech controls are unchanged", () => {
  it("the Giver screen still offers Hear it, Slowly and spoken hints", () => {
    const s = start(SAMPLE_SET);
    const html = renderToStaticMarkup(h(GiverRound, { state: s, dispatch: () => undefined }));
    expect(html).toContain("Hear it");
    expect(html).toContain("Slowly");
    expect(currentWord(s)).toBeTruthy();
  });
});

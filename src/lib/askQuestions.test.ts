import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE_SET, type VocabWord } from "@/data/vocab";
import { TakerRound } from "@/components/TakerRound";
import { ClassService } from "@/lib/class/service";
import { MemoryKV } from "@/lib/class/kv";
import { ASK_KINDS, questionsFor, resolveAskKind } from "@/lib/askQuestions";
import { createInitialState, currentWord, gameReducer, redactForTaker, type GameState } from "@/lib/game";
import { coerceWord, validateWord } from "@/lib/studio/validation";


const sample = (w: string) => SAMPLE_SET.words.find((x) => x.word === w)!;
const WHERE = "Where do you use it?";
const all = (qs: string[]) => qs.join(" | ");

describe("question ideas follow the kind of word", () => {
  it("concrete objects get look/use questions", () => {
    const qs = questionsFor(sample("umbrella"));
    expect(resolveAskKind(sample("umbrella"))).toBe("object");
    expect(qs).toContain("What does it look like?");
    expect(qs).toContain("What do you do with it?");
    expect(qs).toContain("What do you use it for?");
  });
  it("actions ask what someone is doing", () => {
    for (const w of ["whisper", "borrow", "procrastinate"]) {
      expect(resolveAskKind(sample(w))).toBe("action");
      expect(questionsFor(sample(w))).toContain("What is someone doing?");
      expect(questionsFor(sample(w))).toContain("What does someone do?");
      expect(questionsFor(sample(w))).toContain("When might someone do this?");
    }
  });
  it("feelings and attitudes ask how the person feels — and 'reluctant' never shows 'Where do you use it?'", () => {
    for (const w of ["reluctant", "nostalgic"]) {
      expect(resolveAskKind(sample(w))).toBe("feeling");
      const qs = questionsFor(sample(w));
      expect(qs).toContain("How does the person feel?");
      expect(qs).toContain("Do they want to do something?");
      expect(qs).toContain("Why might someone feel this way?");
      expect(qs).not.toContain(WHERE);
      expect(all(qs)).not.toMatch(/look like|made of|where do you use/i);
    }
  });
  it("'reluctant' and 'wooden' are both adjectives but get different questions", () => {
    const wooden = { partOfSpeech: "adjective" as const, category: "Materials" };
    expect(resolveAskKind(wooden)).toBe("quality");
    expect(questionsFor(wooden)).not.toEqual(questionsFor(sample("reluctant")));
    expect(questionsFor(wooden)).not.toContain("How does the person feel?");
  });
  it("abstract concepts ask for examples", () => {
    expect(resolveAskKind(sample("deadline"))).toBe("concept");
    expect(questionsFor(sample("deadline"))).toContain("Can you give me an example?");
    expect(questionsFor(sample("deadline"))).toContain("What kind of situation involves this?");
    expect(questionsFor(sample("deadline"))).toContain("Is it related to people's behavior?");
  });
  it("expressions ask when someone would say it", () => {
    const e = { partOfSpeech: "phrase" as const, category: "Daily talk" };
    expect(resolveAskKind(e)).toBe("expression");
    expect(questionsFor(e)).toContain("When would someone say this?");
    expect(questionsFor(e)).toContain("What does it mean in that situation?");
  });
  it("a teacher's askKind overrides the automatic choice", () => {
    expect(resolveAskKind({ partOfSpeech: "noun", category: "Everyday objects", askKind: "concept" })).toBe("concept");
    expect(resolveAskKind({ partOfSpeech: "noun", category: "Everyday objects", askKind: "bogus" })).toBe("object");
  });
  it("every kind has enough varied, natural prompts, none of which can name a word", () => {
    for (const k of ASK_KINDS) {
      const qs = questionsFor({ askKind: k, partOfSpeech: "noun" });
      expect(qs.length).toBeGreaterThanOrEqual(4);
      expect(new Set(qs).size).toBe(qs.length);
      for (const q of qs) expect(q).toMatch(/^[A-Z][^"“”]*\?$/);
    }
  });
  it("the same question is not used for every word in the preset", () => {
    const firsts = new Set(SAMPLE_SET.words.map((w) => questionsFor(w)[0]));
    expect(firsts.size).toBeGreaterThan(3);
    for (const w of SAMPLE_SET.words) {
      // Abstract, feeling and action words never get the object-only prompt.
      if (resolveAskKind(w) !== "object") expect(questionsFor(w)).not.toContain(WHERE);
    }
  });
});

describe("saved vocabulary and Studio", () => {
  it("older words without askKind keep working; a valid askKind is kept and a bad one is dropped", () => {
    const old = { ...sample("reluctant") } as VocabWord;
    delete old.askKind;
    expect(questionsFor(old)).toContain("How does the person feel?");
    expect(validateWord(old).some((i) => i.severity === "error")).toBe(false);
    const good = coerceWord({ ...old, askKind: "feeling" }, { id: "x" });
    expect("word" in good && good.word.askKind).toBe("feeling");
    const bad = coerceWord({ ...old, askKind: "banana" }, { id: "x" });
    expect("word" in bad && "askKind" in bad.word).toBe(false);
  });
});

describe("Giver/Taker privacy and both modes", () => {
  const start = (): GameState => {
    const words = SAMPLE_SET.words.map((w, i) => ({ ...w, id: `w${i}` }));
    let s = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words });
    s = gameReducer(s, { type: "CONTINUE" });
    return gameReducer(s, { type: "PICK", wordId: words.find((w) => w.word === "reluctant")!.id });
  };
  it("demo: the Taker screen for 'reluctant' shows a feeling question, never 'Where do you use it?', and leaks nothing", () => {
    const s = start();
    const w = currentWord(s)!;
    const html = renderToStaticMarkup(h(TakerRound, { state: redactForTaker(s), dispatch: () => undefined }));
    expect(html).toContain("How does the person feel?");
    expect(html).not.toContain(WHERE);
    for (const secret of [w.word, w.hints[0], w.meaning, w.example, w.giverInfo!.use!, ...(w.ja ?? [])].filter(Boolean)) {
      expect(html).not.toContain(secret);
    }
  });
  it("the redacted state carries only the coarse askKind", () => {
    const t = redactForTaker(start());
    const w = currentWord(t)!;
    expect(w.askKind).toBe("feeling");
    expect(w.word).toBe("");
    expect(w.giverInfo).toBeUndefined();
  });
  it("classroom: the Taker's payload has the kind label but no word, Japanese answer, opening hint or Giver notes", async () => {
    let now = 1_000_000;
    const svc = new ClassService(new MemoryKV(() => now), () => now, {});
    const set = SAMPLE_SET.words;
    const created = await svc.createActivity({ title: "t", words: set });
    if (!created.ok) throw new Error("create");
    const id = created.activity.id;
    const join = async (n: string) => { const r = await svc.join({ activityId: id, group: "7", name: n }); if (!r.ok) throw new Error("join"); return r; };
    const A = await join("Aki"), B = await join("Ben");
    const act = (t: string, action: object) => svc.act({ activityId: id, group: "7", token: t, opId: Math.random().toString(36), action: action as never });
    await act(A.token, { type: "PROPOSE_ROLES", giver: "me" }); await act(B.token, { type: "CONFIRM_ROLES" }); await act(A.token, { type: "CONTINUE" });
    const target = set.find((w) => w.word === "reluctant")!;
    await act(A.token, { type: "PICK", wordId: target.id });
    const r = await svc.getView({ activityId: id, group: "7", token: B.token });
    if (!r.ok || r.unchanged) throw new Error("view");
    const json = JSON.stringify(r.view);
    const inPlay = r.view.game!.words.find((w) => w.id === target.id)!;
    expect(inPlay.askKind).toBe("feeling");
    for (const secret of [target.word, target.hints[0], target.meaning, target.example, target.giverInfo!.use!, ...(target.ja ?? [])].filter(Boolean)) {
      expect(json).not.toContain(secret);
    }
    const html = renderToStaticMarkup(h(TakerRound, { state: r.view.game!, dispatch: () => undefined }));
    expect(html).toContain("How does the person feel?");
    expect(html).not.toContain(WHERE);
  });
});

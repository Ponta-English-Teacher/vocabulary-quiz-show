import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { handleStudioRequest } from "./ai/service";
import { chatPrompt, generatePrompt, hintsPrompt, approvedPrompt, replacePrompt } from "./ai/prompts";
import { sanitizeBrief } from "./ai/parse";
import { EMPTY_BRIEF, type Brief } from "./types";

const PREF = "Use word origins for the weekdays when they are accurate.";
const brief: Brief = { ...EMPTY_BRIEF, topic: "Weekdays", level: "A2", learnerFocus: PREF, objectives: ["explain days of the week"] };
const word = { ...SAMPLE_SET.words[0], word: "Tuesday", hints: ["a", "b", "c"] };
const sys = (m: { content: string }[]) => m[0].content;
const user = (m: { content: string }[]) => m[m.length - 1].content;

describe("hint-writing instructions", () => {
  it("every item-writing prompt carries the quality guidance without rigid slots", () => {
    for (const m of [generatePrompt(brief, 5, []), approvedPrompt(brief, ["Tuesday"]), replacePrompt(brief, word, []), hintsPrompt(brief, word)]) {
      const s = sys(m);
      expect(s).toMatch(/HINT QUALITY/);
      expect(s).toMatch(/distinctive and meaningful/);
      expect(s).toMatch(/Do NOT give every word the same pattern/);
      expect(s).toMatch(/never invent|Never invent/i);
      expect(s).toMatch(/never a required slot/);
      expect(s).toMatch(/hint 1 = the OPENING HINT/); // the free Giver-only opening hint is unchanged
      expect(s).not.toMatch(/hint 1 must (explain|be) word origins/i);
    }
  });
  it("requires new information per hint, a conversation-starting hint 1, no filler, and gives good-versus-poor examples", () => {
    for (const m of [generatePrompt(brief, 5, []), approvedPrompt(brief, ["Tuesday"]), replacePrompt(brief, word, []), hintsPrompt(brief, word)]) {
      const s = sys(m);
      expect(s).toMatch(/add NEW information/);
      expect(s).toMatch(/situation the Giver can describe -> a distinctive feature or contrast that narrows it -> a clear, direct explanation[\s\S]*not a template/);
      expect(s).toMatch(/Hint 1 should start a conversation[\s\S]*must not already define the word/);
      expect(s).toMatch(/Avoid filler openings such as "This word describes\.\.\."/);
      expect(s).toMatch(/POOR:[\s\S]*GOOD:/);
      expect(s).toMatch(/LATEST explicit instruction wins/);
      expect(s).toMatch(/limits on content or order/);
    }
  });
  it("the examples do not use the words from the evaluation sets, so they cannot be copied", () => {
    const ex = sys(generatePrompt(brief, 5, []));
    for (const w of ["Tuesday", "hesitate", "stubborn", "convenience store", "whisper"]) expect(ex).not.toContain(`"${w}" —`);
  });
  it("the good examples themselves obey the app's own hint checks", async () => {
    const { hintProblems } = await import("./validation");
    const mk = (word: string, hints: string[]) => ({ ...word_, word, hints } as never);
    const word_ = word;
    expect(hintProblems(mk("kettle", ["Someone gets up early and wants a hot drink, but first they have to wait a few minutes.", "It makes a loud noise when the water is ready, and it often has a spout and a handle.", "You fill it with water, switch it on, and pour the water into your cup for tea or coffee."]))).toEqual([]);
    expect(hintProblems(mk("nervous", ["Imagine you are waiting outside a room before an important interview.", "Your hands feel cold and your stomach feels strange, even though nothing bad has happened yet.", "It is the feeling before something important; being ____ is not as strong as being scared."]))).toEqual([]);
    expect(hintProblems(mk("fridge", ["When you come home hungry, you open this and look inside, and a little light comes on.", "It is cold inside, and milk and eggs usually stay in it.", "It keeps food fresh; the part for ice cream is called the freezer."]))).toEqual([]);
  });
  it("teacher hint preferences reach generation, replacement and hint regeneration", () => {
    for (const m of [generatePrompt(brief, 5, []), approvedPrompt(brief, ["Tuesday"]), replacePrompt(brief, word, []), hintsPrompt(brief, word)]) {
      expect(user(m)).toContain(PREF);
      expect(user(m)).toContain("explain days of the week");
    }
    expect(user(hintsPrompt(brief, word, "Make hint 1 about food"))).toContain("Make hint 1 about food");
  });
  it("the chat producer is told to record hint wishes in the brief and keep them", () => {
    expect(sys(chatPrompt([{ role: "teacher", text: "hi" } as never], brief))).toMatch(/record it in brief\.learnerFocus/);
  });
  it("a long preference survives the brief round trip", () => {
    const long = "x".repeat(450);
    expect(sanitizeBrief({ learnerFocus: long }, EMPTY_BRIEF).learnerFocus).toHaveLength(450);
  });
});

describe("automatic hint repair keeps the teacher's instruction", () => {
  it("passes the teacher's generate instruction and brief preferences into each repair request", async () => {
    const bodies: string[] = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      const text = String((init as RequestInit).body);
      bodies.push(text);
      const msgs = (JSON.parse(text) as { messages: { content: string }[] }).messages;
      const asked = /APPROVED this exact word list: (\[[^\]]*\])/.exec(msgs[msgs.length - 1].content);
      const out = asked
        ? { words: (JSON.parse(asked[1]) as string[]).map((w) => ({ word: w, accept: [], partOfSpeech: "noun", cefr: "A2", category: "Days", meaning: "a day of the week", example: `See you on ${w}.`, hints: ["It comes after another day.", "Its name is connected with a god of war.", "It is the day after Monday; it begins with a T sound and then another word."] })) }
        : { hints: ["You may have a quiz on this day.", "Its name is connected with a god of war.", "It comes right after Monday."] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }), { status: 200 });
    });
    // "Tuesday" in a hint leaks the word → forces a repair
    const leakF = vi.fn(async (u: unknown, init: unknown) => {
      const r = await f(u, init);
      const j = await r.json();
      const c = JSON.parse(j.choices[0].message.content);
      if (c.words) c.words[0].hints[2] = "Tuesday is the one after Monday.";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
    });
    const r = await handleStudioRequest({ task: "generate", brief, count: 1, exclude: [], approved: ["Tuesday"], instruction: "Keep it friendly." }, { apiKey: "k", model: "m", fetchImpl: leakF as never });
    expect(r.body.ok).toBe(true);
    const repair = bodies.find((b) => b.includes("Your previous hints were rejected"));
    expect(repair).toBeDefined();
    expect(repair).toContain("Keep it friendly.");
    expect(repair).toContain("Use word origins");
  });
});

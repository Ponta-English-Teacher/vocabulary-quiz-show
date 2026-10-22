import { describe, expect, it } from "vitest";
import { DEFAULT_SET } from "@/data/vocab";
import {
  completedCount,
  createInitialState,
  currentWord,
  gameReducer,
  getFinalResult,
  redactForTaker,
  remainingCount,
  type GameAction,
  type GameState,
} from "./game";

const id = (word: string) => DEFAULT_SET.words.find((w) => w.word === word)!.id;
const run = (actions: GameAction[], from: GameState = createInitialState()) =>
  actions.reduce(gameReducer, from);

const start = (): GameState =>
  run([{ type: "START", names: ["Aki", "Ben"], words: DEFAULT_SET.words }]);

const toBoard = () => run([{ type: "CONTINUE" }], start());

function playWord(state: GameState, wordId: string, how: "solve" | "skip", hints = 0): GameState {
  let s = run([{ type: "PICK", wordId }], state);
  for (let i = 0; i < hints; i++) s = run([{ type: "ADJUST_HINTS", delta: 1 }], s);
  const word = currentWord(s)!;
  s = run(how === "solve" ? [{ type: "GUESS", text: word.word }] : [{ type: "SKIP" }], s);
  return s;
}

describe("data", () => {
  it("has 10 unique words with hints that never contain the word", () => {
    const { words } = DEFAULT_SET;
    expect(words).toHaveLength(10);
    expect(new Set(words.map((w) => w.id)).size).toBe(10);
    for (const w of words) {
      expect(w.hints.length).toBeGreaterThanOrEqual(3);
      for (const h of w.hints) expect(h.toLowerCase()).not.toContain(w.word.toLowerCase());
    }
  });
});

describe("start and setup", () => {
  it("starts with an intro role screen, Player 1 as Giver, all words pending", () => {
    const s = start();
    expect(s.phase).toBe("switch");
    expect(s.switchKind).toBe("intro");
    expect(s.giver).toBe(0);
    expect(remainingCount(s)).toBe(10);
    expect(s.players.map((p) => p.name)).toEqual(["Aki", "Ben"]);
  });
  it("defaults blank names and de-duplicates identical ones", () => {
    const blank = run([{ type: "START", names: ["", "  "], words: DEFAULT_SET.words }]);
    expect(blank.players.map((p) => p.name)).toEqual(["Player 1", "Player 2"]);
    const same = run([{ type: "START", names: ["Sam", "sam"], words: DEFAULT_SET.words }]);
    expect(same.players[0].name).not.toBe(same.players[1].name);
  });
  it("ignores actions in the wrong phase", () => {
    expect(run([{ type: "PICK", wordId: id("umbrella") }], start()).phase).toBe("switch");
    expect(run([{ type: "SKIP" }], toBoard()).phase).toBe("board");
  });
});

describe("round flow", () => {
  it("lets players pick any pending word", () => {
    const s = run([{ type: "PICK", wordId: id("nostalgic") }], toBoard());
    expect(s.phase).toBe("round");
    expect(currentWord(s)?.id).toBe(id("nostalgic"));
  });
  it("reveals prepared hints in order, counting each, up to the available number", () => {
    let s = run([{ type: "PICK", wordId: id("umbrella") }], toBoard());
    expect(s.revealedHints).toBe(1); // the free opening hint is already showing…
    expect(s.hintsUsed).toBe(0); // …and costs nothing
    s = run([{ type: "REVEAL_HINT" }, { type: "REVEAL_HINT" }], s);
    expect(s.revealedHints).toBe(3);
    expect(s.hintsUsed).toBe(2); // only the two extra hints are paid
    s = run([{ type: "REVEAL_HINT" }, { type: "REVEAL_HINT" }], s);
    expect(s.revealedHints).toBe(3); // capped at the three prepared hints
    expect(s.hintsUsed).toBe(2);
  });
  it("manual hint counter goes up, but cannot drop below revealed hints", () => {
    let s = run([{ type: "PICK", wordId: id("umbrella") }, { type: "REVEAL_HINT" }], toBoard());
    s = run([{ type: "ADJUST_HINTS", delta: 1 }, { type: "ADJUST_HINTS", delta: 1 }], s);
    expect(s.hintsUsed).toBe(3);
    s = run(Array(10).fill({ type: "ADJUST_HINTS", delta: -1 }), s);
    expect(s.hintsUsed).toBe(1);
  });
  it("wrong and close guesses keep the round open, with no score change", () => {
    let s = run([{ type: "PICK", wordId: id("umbrella") }, { type: "GUESS", text: "raincoat" }], toBoard());
    expect(s.phase).toBe("round");
    expect(s.feedback).toMatchObject({ kind: "wrong", n: 1 });
    s = run([{ type: "GUESS", text: "umbrela" }], s);
    expect(s.feedback).toMatchObject({ kind: "close", n: 2 });
    expect(s.wrongGuesses).toBe(2);
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
    s = run([{ type: "GUESS", text: "   " }], s);
    expect(s.wrongGuesses).toBe(2); // empty ignored
  });
});

describe("scoring in play", () => {
  it("awards Taker full and Giver half; fewer hints score higher", () => {
    const zero = playWord(toBoard(), id("umbrella"), "solve", 0);
    expect(zero.phase).toBe("reveal");
    expect(zero.players[1].score).toBe(100); // Ben is Taker
    expect(zero.players[0].score).toBe(50); // Aki is Giver
    expect(zero.lastResult).toMatchObject({ outcome: "solved", takerPoints: 100, giverPoints: 50 });

    const three = playWord(toBoard(), id("umbrella"), "solve", 3);
    expect(three.players[1].score).toBe(55);
    expect(three.players[1].score).toBeLessThan(zero.players[1].score);
  });
  it("scores nothing for a skip and still marks the word done", () => {
    const s = playWord(toBoard(), id("borrow"), "skip", 2);
    expect(s.phase).toBe("reveal");
    expect(s.statuses[id("borrow")]).toBe("skipped");
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
    expect(completedCount(s)).toBe(1);
  });
  it("accepts a correct answer after earlier misses", () => {
    let s = run([{ type: "PICK", wordId: id("whisper") }, { type: "GUESS", text: "shout" }], toBoard());
    s = run([{ type: "GUESS", text: "Whisper!" }], s);
    expect(s.statuses[id("whisper")]).toBe("solved");
    expect(s.lastResult?.wrongGuesses).toBe(1);
  });
});

describe("role switching", () => {
  it("alternates Giver/Taker after every word, solved or skipped", () => {
    let s = toBoard();
    const givers: number[] = [s.giver];
    const ids = DEFAULT_SET.words.map((w) => w.id);
    for (let i = 0; i < 4; i++) {
      s = playWord(s, ids[i], i % 2 ? "skip" : "solve");
      s = run([{ type: "NEXT" }], s);
      expect(s.phase).toBe("switch");
      expect(s.switchKind).toBe("swap");
      s = run([{ type: "CONTINUE" }], s);
      givers.push(s.giver);
    }
    expect(givers).toEqual([0, 1, 0, 1, 0]);
  });
  it("cannot replay a finished word", () => {
    let s = playWord(toBoard(), id("umbrella"), "solve");
    s = run([{ type: "NEXT" }, { type: "CONTINUE" }, { type: "PICK", wordId: id("umbrella") }], s);
    expect(s.phase).toBe("board");
  });
});

function playAll(plan: ("solve" | "skip")[]): GameState {
  let s = toBoard();
  DEFAULT_SET.words.forEach((w, i) => {
    s = playWord(s, w.id, plan[i], 0);
    s = run([{ type: "NEXT" }], s);
    if (s.phase === "switch") s = run([{ type: "CONTINUE" }], s);
  });
  return s;
}

describe("full game and final result", () => {
  it("ends after all 10 words with the final phase and a winner", () => {
    const s = playAll(Array(10).fill("solve"));
    expect(s.phase).toBe("final");
    expect(s.history).toHaveLength(10);
    expect(s.players[0].score + s.players[1].score).toBe(10 * 150);
    // Words 0,2,4,6,8: Aki Giver → Ben Taker (100 each); the rest reversed → totals tie
    expect(getFinalResult(s.players)).toEqual({ kind: "tie" });
  });
  it("declares the higher scorer the winner", () => {
    // Aki is the Taker on odd-numbered words; skip Ben's-Taker words to favour Aki.
    const s = playAll(["skip", "solve", "skip", "solve", "skip", "solve", "skip", "solve", "skip", "solve"]);
    expect(s.players[0].score).toBe(500);
    expect(s.players[1].score).toBe(250);
    expect(getFinalResult(s.players)).toEqual({ kind: "winner", winner: 0 });
  });
  it("supports a tie, including 0–0 when everything is skipped", () => {
    const s = playAll(Array(10).fill("skip"));
    expect(s.phase).toBe("final");
    expect(getFinalResult(s.players)).toEqual({ kind: "tie" });
  });
  it("RESET returns to a clean welcome state", () => {
    expect(run([{ type: "RESET" }], playAll(Array(10).fill("solve")))).toEqual(createInitialState());
  });
});

describe("Taker privacy", () => {
  it("never leaks unsolved word text to the Taker view", () => {
    let s = run([{ type: "PICK", wordId: id("procrastinate") }], toBoard());
    s = run([{ type: "REVEAL_HINT" }], s);
    const json = JSON.stringify(redactForTaker(s)).toLowerCase();
    for (const w of DEFAULT_SET.words) expect(json).not.toContain(`"${w.word}"`);
    expect(json).not.toContain("procrastinat");
    expect(json).not.toContain("put off"); // meaning/hint text
    expect(redactForTaker(s).revealedHints).toBe(2); // opening hint + one revealed
  });
  it("shows the word again once the round is revealed", () => {
    const s = playWord(toBoard(), id("umbrella"), "solve");
    const view = redactForTaker(s);
    expect(view.words.find((w) => w.id === id("umbrella"))?.word).toBe("umbrella");
    expect(view.words.find((w) => w.id === id("borrow"))?.word).toBe("");
  });
});

// ---- communication-focused pair work: opening hint, Japanese answers, scoring ----------------------------------

const pick = (word: string) => run([{ type: "PICK", wordId: id(word) }], toBoard());

describe("opening hint", () => {
  it("is on screen from the first moment of every round, with no hints charged", () => {
    const s = pick("umbrella");
    expect(s.revealedHints).toBe(1);
    expect(s.hintsUsed).toBe(0);
    expect(currentWord(s)!.hints[0]).toMatch(/rain/);
  });
  it("is free: an immediate English answer is worth the full 100 (Giver 50)", () => {
    const s = run([{ type: "GUESS", text: "umbrella" }], pick("umbrella"));
    expect(s.lastResult).toMatchObject({ outcome: "solved", hintsUsed: 0, takerPoints: 100, giverPoints: 50, answeredIn: "en" });
  });
  it("each extra hint costs points: 100 → 85 → 70", () => {
    let s = pick("umbrella");
    expect(s.hintsUsed).toBe(0);
    s = run([{ type: "REVEAL_HINT" }], s);
    expect(s.hintsUsed).toBe(1);
    s = run([{ type: "REVEAL_HINT" }], s);
    expect(s.hintsUsed).toBe(2);
    const done = run([{ type: "GUESS", text: "umbrella" }], s);
    expect(done.lastResult).toMatchObject({ hintsUsed: 2, takerPoints: 70, giverPoints: 35 });
  });
  it("starts fresh for every word (a new round never inherits revealed hints)", () => {
    let s = run([{ type: "REVEAL_HINT" }, { type: "REVEAL_HINT" }, { type: "GUESS", text: "umbrella" }, { type: "NEXT" }, { type: "CONTINUE" }], pick("umbrella"));
    s = run([{ type: "PICK", wordId: id("borrow") }], s);
    expect(s).toMatchObject({ revealedHints: 1, hintsUsed: 0 });
  });
  it("a word with no prepared hints still works (nothing to show, nothing charged)", () => {
    const bare = { ...DEFAULT_SET.words[0], id: "bare", hints: [] };
    const s = run([{ type: "START", names: ["A", "B"], words: [bare] }, { type: "CONTINUE" }, { type: "PICK", wordId: "bare" }]);
    expect(s).toMatchObject({ revealedHints: 0, hintsUsed: 0 });
  });
  it("spoken hints add to the cost but can never be undone below the revealed extra hints", () => {
    let s = run([{ type: "REVEAL_HINT" }, { type: "ADJUST_HINTS", delta: 1 }], pick("umbrella"));
    expect(s.hintsUsed).toBe(2); // 1 revealed + 1 spoken
    s = run(Array(5).fill({ type: "ADJUST_HINTS", delta: -1 }), s);
    expect(s.hintsUsed).toBe(1); // the revealed one stays; the free opening hint is not counted
  });
});

describe("Japanese answers", () => {
  const ja = (s: GameState, text: string) => run([{ type: "GUESS_JA", text }], s);

  it("a correct Japanese answer earns HALF the available points and ends the round", () => {
    const s = ja(pick("umbrella"), "傘");
    expect(s.phase).toBe("reveal");
    expect(s.lastResult).toMatchObject({ outcome: "solved", answeredIn: "ja", hintsUsed: 0, takerPoints: 50, giverPoints: 25 });
    expect(s.players.map((p) => p.score)).toEqual([25, 50]); // Aki is Giver, Ben is Taker
  });
  it("uses the same hint costs: one extra hint → English 85 / Japanese 43; two → 70 / 35", () => {
    const one = run([{ type: "REVEAL_HINT" }], pick("umbrella"));
    expect(ja(one, "傘").lastResult).toMatchObject({ takerPoints: 43, giverPoints: 22 });
    expect(run([{ type: "GUESS", text: "umbrella" }], one).lastResult).toMatchObject({ takerPoints: 85, giverPoints: 43 });
    const two = run([{ type: "REVEAL_HINT" }], one);
    expect(ja(two, "かさ").lastResult).toMatchObject({ takerPoints: 35, giverPoints: 18 });
  });
  it("accepts approved synonyms and normalises writing (katakana, spaces, polite endings)", () => {
    expect(ja(pick("scissors"), "ハサミです").lastResult?.answeredIn).toBe("ja");
    expect(ja(pick("deadline"), "期限").lastResult?.answeredIn).toBe("ja");
  });
  it("an incorrect Japanese answer keeps the round open, costs nothing and is counted as a miss", () => {
    const s = ja(pick("umbrella"), "かばん");
    expect(s.phase).toBe("round");
    expect(s.feedback).toMatchObject({ kind: "wrong", lang: "ja", guess: "かばん" });
    expect(s.wrongGuesses).toBe(1);
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
    // …and the Taker can still win, in either language
    expect(ja(s, "傘").lastResult?.takerPoints).toBe(50);
    expect(run([{ type: "GUESS", text: "umbrella" }], s).lastResult?.takerPoints).toBe(100);
  });
  it("an English miss and a Japanese miss both keep playing", () => {
    let s = run([{ type: "GUESS", text: "raincoat" }], pick("umbrella"));
    s = ja(s, "かばん");
    expect(s).toMatchObject({ phase: "round", wrongGuesses: 2 });
    expect(s.feedback?.n).toBe(2);
  });
  it("a Japanese answer to a word with NO approved Japanese equivalent earns nothing and says so", () => {
    const noJa = { ...DEFAULT_SET.words[0], id: "nj", ja: undefined };
    let s = run([{ type: "START", names: ["A", "B"], words: [noJa] }, { type: "CONTINUE" }, { type: "PICK", wordId: "nj" }]);
    s = ja(s, "傘");
    expect(s.phase).toBe("round");
    expect(s.feedback).toMatchObject({ kind: "no-ja-credit", lang: "ja" });
    expect(s.wrongGuesses).toBe(0);
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
    // the Taker can still answer in English
    expect(run([{ type: "GUESS", text: "umbrella" }], s).phase).toBe("reveal");
  });
  it("text that isn't Japanese is told so and is not a miss", () => {
    const s = ja(pick("umbrella"), "umbrella");
    expect(s.phase).toBe("round");
    expect(s.feedback).toMatchObject({ kind: "not-japanese", lang: "ja" });
    expect(s.wrongGuesses).toBe(0);
  });
  it("an empty Japanese answer is ignored", () => {
    const before = pick("umbrella");
    expect(ja(before, "   ")).toBe(before);
  });
});

describe("one answer scores once", () => {
  it("after a correct English answer a Japanese answer (or another English one) changes nothing", () => {
    const done = run([{ type: "GUESS", text: "umbrella" }], pick("umbrella"));
    expect(done.phase).toBe("reveal");
    expect(run([{ type: "GUESS_JA", text: "傘" }], done)).toBe(done);
    expect(run([{ type: "GUESS", text: "umbrella" }], done)).toBe(done);
    expect(done.history).toHaveLength(1);
  });
  it("after a correct Japanese answer an English answer changes nothing", () => {
    const done = run([{ type: "GUESS_JA", text: "傘" }], pick("umbrella"));
    expect(run([{ type: "GUESS", text: "umbrella" }], done)).toBe(done);
    expect(done.players[1].score).toBe(50);
  });
});

describe("what the Taker's view contains", () => {
  it("hides the opening hint (Giver only), shows only EXTRA hints the Giver reveals, and exposes no Japanese text", () => {
    let s = pick("umbrella");
    let view = redactForTaker(s);
    const w = view.words.find((x) => x.id === id("umbrella"))!;
    expect(w.hints).toEqual(["", "", ""]);
    s = run([{ type: "REVEAL_HINT" }], s);
    expect(redactForTaker(s).words.find((x) => x.id === id("umbrella"))!.hints).toEqual(["", DEFAULT_SET.words[0].hints[1], ""]);
    view = redactForTaker(s);
    const json = JSON.stringify(view);
    expect(json).not.toContain("傘");
    expect(json).not.toContain("かさ");
    expect(json).not.toContain("opens and closes"); // Giver notes
    // Japanese credit is knowable (placeholders of the same length) but the answers are not
    expect(view.words.find((x) => x.id === id("umbrella"))!.ja).toEqual(["", ""]);
    expect(view.words.find((x) => x.id === id("umbrella"))!.giverInfo).toBeUndefined();
  });
  it("hints of words not in play are never shown", () => {
    const view = redactForTaker(pick("umbrella"));
    for (const w of view.words.filter((x) => x.id !== id("umbrella"))) expect(w.hints.every((h) => h === "")).toBe(true);
  });
  it("after the round the Japanese meaning and notes are shown", () => {
    const done = run([{ type: "GUESS", text: "umbrella" }], pick("umbrella"));
    const w = redactForTaker(done).words.find((x) => x.id === id("umbrella"))!;
    expect(w.ja).toEqual(["傘", "かさ"]);
  });
});

describe("full game with mixed English and Japanese answers", () => {
  it("plays all ten words, swapping roles, with consistent integer totals", () => {
    let s = toBoard();
    let expectA = 0, expectB = 0;
    DEFAULT_SET.words.forEach((w, i) => {
      s = run([{ type: "PICK", wordId: w.id }], s);
      const extra = i % 3; // 0, 1, 2 extra hints
      s = run(Array(extra).fill({ type: "REVEAL_HINT" }), s);
      const giver = s.giver;
      const lang = i % 2 === 0 ? "en" : "ja";
      s = run([lang === "en" ? { type: "GUESS", text: w.word } : { type: "GUESS_JA", text: w.ja![0] }], s);
      const taker = Math.max(25, 100 - 15 * extra) * (lang === "ja" ? 0.5 : 1);
      const takerPts = Math.round(taker), giverPts = Math.round(takerPts * 0.5);
      if (giver === 0) { expectA += giverPts; expectB += takerPts; } else { expectB += giverPts; expectA += takerPts; }
      const after: GameAction[] = remainingCount(s) === 0 ? [{ type: "NEXT" }] : [{ type: "NEXT" }, { type: "CONTINUE" }];
      s = run(after, s);
    });
    expect(s.phase).toBe("final");
    expect(s.players.map((p) => p.score)).toEqual([expectA, expectB]);
    expect(s.players.every((p) => Number.isInteger(p.score))).toBe(true);
    expect(s.history.filter((h) => h.answeredIn === "ja")).toHaveLength(5);
    expect(getFinalResult(s.players).kind).not.toBeUndefined();
  });
});

describe("sets saved before these features existed", () => {
  it("play normally with no Japanese or Giver notes (English scoring unchanged)", () => {
    const old = DEFAULT_SET.words.map(({ ja: _ja, giverInfo: _g, ...rest }) => { void _ja; void _g; return rest; });
    let s = run([{ type: "START", names: ["A", "B"], words: old }, { type: "CONTINUE" }, { type: "PICK", wordId: old[0].id }]);
    expect(s.revealedHints).toBe(1);
    expect(redactForTaker(s).words[0].ja).toEqual([]);
    s = run([{ type: "GUESS", text: "umbrella" }], s);
    expect(s.lastResult).toMatchObject({ takerPoints: 100, giverPoints: 50 });
  });
  it("results saved without answeredIn are still valid", () => {
    const done = run([{ type: "GUESS", text: "umbrella" }], pick("umbrella"));
    const legacy = { ...done, history: done.history.map(({ answeredIn: _a, ...r }) => { void _a; return r; }) };
    expect(legacy.history[0].takerPoints).toBe(100);
  });
});

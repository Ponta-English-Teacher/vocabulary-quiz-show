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
    s = run([{ type: "REVEAL_HINT" }, { type: "REVEAL_HINT" }], s);
    expect(s.revealedHints).toBe(2);
    expect(s.hintsUsed).toBe(2);
    s = run([{ type: "REVEAL_HINT" }, { type: "REVEAL_HINT" }, { type: "REVEAL_HINT" }], s);
    expect(s.revealedHints).toBe(3); // capped
    expect(s.hintsUsed).toBe(3);
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
    expect(redactForTaker(s).revealedHints).toBe(1);
  });
  it("shows the word again once the round is revealed", () => {
    const s = playWord(toBoard(), id("umbrella"), "solve");
    const view = redactForTaker(s);
    expect(view.words.find((w) => w.id === id("umbrella"))?.word).toBe("umbrella");
    expect(view.words.find((w) => w.id === id("borrow"))?.word).toBe("");
  });
});

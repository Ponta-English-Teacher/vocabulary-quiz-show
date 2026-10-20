import { describe, expect, it } from "vitest";
import { checkAnswer, levenshtein, normalize } from "./answer";

const umbrella = { word: "umbrella" };
const suitcase = { word: "suitcase", accept: ["suit case"] };

describe("normalize", () => {
  it("lower-cases, strips punctuation and accents", () => {
    expect(normalize("  Ümbrella!! ")).toBe("umbrella");
    expect(normalize("It’s   a  test.")).toBe("it's a test".replace("'", " "));
  });
});

describe("levenshtein", () => {
  it("counts edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });
});

describe("checkAnswer", () => {
  it("accepts exact answers ignoring case and punctuation", () => {
    expect(checkAnswer("Umbrella", umbrella)).toBe("correct");
    expect(checkAnswer(" umbrella. ", umbrella)).toBe("correct");
  });
  it("accepts dictated short sentences containing the word", () => {
    expect(checkAnswer("Is it an umbrella", umbrella)).toBe("correct");
    expect(checkAnswer("it is an umbrella i think maybe", umbrella)).not.toBe("correct");
  });
  it("accepts listed variants", () => {
    expect(checkAnswer("suit case", suitcase)).toBe("correct");
  });
  it("flags small spelling slips as close, not correct", () => {
    expect(checkAnswer("umbrela", umbrella)).toBe("close");
    expect(checkAnswer("umbrellas", umbrella)).toBe("close");
  });
  it("rejects unrelated words", () => {
    expect(checkAnswer("raincoat", umbrella)).toBe("wrong");
    expect(checkAnswer("cat", { word: "car" })).toBe("wrong"); // short words get no leniency
  });
  it("ignores empty input", () => {
    expect(checkAnswer("   ", umbrella)).toBe("empty");
    expect(checkAnswer("?!", umbrella)).toBe("empty");
  });
  it("does not match a word inside another word", () => {
    expect(checkAnswer("bumbrella", umbrella)).toBe("close");
  });
});

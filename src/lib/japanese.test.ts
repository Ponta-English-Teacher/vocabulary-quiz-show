import { describe, expect, it } from "vitest";
import { checkJapaneseAnswer, japaneseDisplay, matchesJapanese, normalizeJa } from "./japanese";

const COLANDER = ["ざる", "水切りざる"];

describe("normalizeJa", () => {
  it("treats hiragana, katakana and half-width katakana as the same", () => {
    expect(normalizeJa("ざる")).toBe(normalizeJa("ザル"));
    expect(normalizeJa("ざる")).toBe(normalizeJa("ｻﾞﾙ"));
  });
  it("ignores spaces, punctuation, the middle dot and full-width forms", () => {
    expect(normalizeJa(" 水切り ざる！ ")).toBe(normalizeJa("水切りざる"));
    expect(normalizeJa("「ざる」。")).toBe("ざる");
    expect(normalizeJa("ＤＶＤ")).toBe("dvd");
    expect(normalizeJa("スーツ・ケース")).toBe(normalizeJa("スーツケース"));
  });
  it("ignores a trailing long-vowel mark (コンピューター = コンピュータ) but keeps an inner one", () => {
    expect(normalizeJa("コンピューター")).toBe(normalizeJa("コンピュータ"));
    expect(normalizeJa("スーツケース")).toContain("ー");
  });
});

describe("checkJapaneseAnswer", () => {
  it("accepts every approved equivalent, including the synonym", () => {
    expect(checkJapaneseAnswer("ざる", COLANDER)).toBe("correct");
    expect(checkJapaneseAnswer("水切りざる", COLANDER)).toBe("correct");
  });
  it("normalises ordinary differences in writing", () => {
    expect(checkJapaneseAnswer("ザル", COLANDER)).toBe("correct");
    expect(checkJapaneseAnswer(" ざ る ", COLANDER)).toBe("correct");
    expect(checkJapaneseAnswer("ざる。", COLANDER)).toBe("correct");
    expect(checkJapaneseAnswer("ＳＨ", ["sh"])).toBe("correct");
  });
  it("accepts polite wrappers and fillers that dictation and students add", () => {
    for (const a of ["ざるです", "えっと、ざる", "それはざるだと思います", "たぶんざるかな", "ざるですか？"]) {
      expect(checkJapaneseAnswer(a, COLANDER), a).toBe("correct");
    }
  });
  it("does NOT accept a negation or a different word built on top of the answer", () => {
    expect(checkJapaneseAnswer("ざるじゃない", COLANDER)).toBe("wrong");
    expect(checkJapaneseAnswer("ざるそば", COLANDER)).toBe("wrong");
  });
  it("does not accept a merely related word, a typo or an unlisted synonym", () => {
    for (const a of ["鍋", "ボウル", "料理", "ざろ", "水切り", "ストレーナー"]) expect(checkJapaneseAnswer(a, COLANDER), a).toBe("wrong");
  });
  it("kanji and kana spellings are separate unless the teacher lists both", () => {
    expect(checkJapaneseAnswer("かさ", ["傘"])).toBe("wrong");
    expect(checkJapaneseAnswer("かさ", ["傘", "かさ"])).toBe("correct");
  });
  it("tells the student when the answer isn't Japanese, without calling it a match", () => {
    expect(checkJapaneseAnswer("colander", COLANDER)).toBe("not-japanese");
    expect(checkJapaneseAnswer("12345", COLANDER)).toBe("not-japanese");
  });
  it("never awards credit when no verified Japanese equivalent exists", () => {
    for (const none of [undefined, [], ["", "  "]]) expect(checkJapaneseAnswer("ざる", none)).toBe("unavailable");
  });
  it("ignores an empty answer", () => {
    expect(checkJapaneseAnswer("   ", COLANDER)).toBe("empty");
    expect(checkJapaneseAnswer("", COLANDER)).toBe("empty");
  });
  it("is deterministic", () => {
    const r = Array.from({ length: 5 }, () => checkJapaneseAnswer("ザルです", COLANDER));
    expect(new Set(r)).toEqual(new Set(["correct"]));
  });
  it("matchesJapanese is false for an empty list", () => {
    expect(matchesJapanese("ざる", [])).toBe(false);
  });
});

describe("japaneseDisplay", () => {
  it("shows up to three equivalents", () => {
    expect(japaneseDisplay(["ざる", "水切りざる", "笊", "ストレーナー"])).toBe("ざる / 水切りざる / 笊");
    expect(japaneseDisplay(undefined)).toBe("");
  });
});

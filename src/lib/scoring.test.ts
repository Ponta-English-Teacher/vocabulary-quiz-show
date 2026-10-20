import { describe, expect, it } from "vitest";
import { FREE_HINTS, giverPointsFor, pointsForHints, takerPointsFor } from "./scoring";

describe("scoring", () => {
  it("gives more points for fewer hints", () => {
    const table = [0, 1, 2, 3, 4, 5, 6, 20].map(pointsForHints);
    expect(table).toEqual([100, 85, 70, 55, 40, 25, 25, 25]);
    for (let i = 1; i < table.length; i++) expect(table[i]).toBeLessThanOrEqual(table[i - 1]);
  });
  it("never goes below the floor and ignores negative input", () => {
    expect(pointsForHints(-3)).toBe(100);
    expect(pointsForHints(999)).toBe(25);
  });
  it("gives the Giver half, rounded", () => {
    expect(giverPointsFor(100)).toBe(50);
    expect(giverPointsFor(85)).toBe(43);
    expect(giverPointsFor(25)).toBe(13);
  });
  it("the opening hint is free: exactly one hint is free and the first rounds' worth is the full 100", () => {
    expect(FREE_HINTS).toBe(1);
    expect(takerPointsFor(0, "en")).toBe(100); // opening hint only
  });
});

describe("English and Japanese points", () => {
  it("an English answer earns the full available points", () => {
    expect([0, 1, 2].map((h) => takerPointsFor(h, "en"))).toEqual([100, 85, 70]);
  });
  it("a Japanese answer earns half, with halves rounded UP (42.5 → 43)", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((h) => takerPointsFor(h, "ja"))).toEqual([50, 43, 35, 28, 20, 13, 13]);
  });
  it("the Giver gets half of the points the Taker was actually awarded", () => {
    const giverEn = [0, 1, 2, 3, 4, 5].map((h) => giverPointsFor(takerPointsFor(h, "en")));
    const giverJa = [0, 1, 2, 3, 4, 5].map((h) => giverPointsFor(takerPointsFor(h, "ja")));
    expect(giverEn).toEqual([50, 43, 35, 28, 20, 13]);
    expect(giverJa).toEqual([25, 22, 18, 14, 10, 7]); // from 50, 43, 35, 28, 20, 13
  });
  it("every amount is an integer, and Japanese never exceeds English", () => {
    for (let h = 0; h < 12; h++) {
      for (const lang of ["en", "ja"] as const) {
        const t = takerPointsFor(h, lang);
        expect(Number.isInteger(t)).toBe(true);
        expect(Number.isInteger(giverPointsFor(t))).toBe(true);
      }
      expect(takerPointsFor(h, "ja")).toBeLessThanOrEqual(takerPointsFor(h, "en"));
    }
  });
});

import { describe, expect, it } from "vitest";
import { giverPointsFor, pointsForHints } from "./scoring";

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
});

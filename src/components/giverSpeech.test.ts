import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const giver = readFileSync(new URL("./GiverRound.tsx", import.meta.url), "utf8");

describe("Giver listening", () => {
  it("can hear the secret word (normal and slow) through the shared one-at-a-time player", () => {
    expect(giver).toMatch(/<SpeakButton id="word" text=\{word\.word\}/);
    expect(giver).toMatch(/<SpeakButton id="word-slow" text=\{word\.word\}/);
  });
  it("can hear each prepared hint once it has been revealed (never before: unrevealed hints cost points)", () => {
    expect(giver).toMatch(/SpeakButton id=\{`hint-\$\{i\}`\} text=\{h\}/);
    // the speaker button lives in the revealed branch only
    const revealedBranch = giver.slice(giver.indexOf("{shown ? ("), giver.indexOf(") : ("));
    expect(revealedBranch).toContain("SpeakButton");
    const hiddenBranch = giver.slice(giver.indexOf(") : ("), giver.indexOf("</li>"));
    expect(hiddenBranch).not.toContain("SpeakButton");
  });
  it("stops playback when the screen goes away", () => {
    expect(giver).toMatch(/useEffect\(\(\) => stopSpeaking, \[\]\)/);
  });
});

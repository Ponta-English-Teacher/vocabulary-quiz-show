import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { createInitialState, gameReducer } from "@/lib/game";
import { GiverPicture, IllustrationRequest } from "./IllustrationHint";
import { GiverRound } from "./GiverRound";

const roundState = (used: boolean, withPicture: boolean) => {
  const words = SAMPLE_SET.words.map((w, i) => (i === 0 && withPicture ? { ...w, illustration: { src: "data:image/jpeg;base64,QUJD" } } : w));
  let s = gameReducer(createInitialState(), { type: "START", names: ["A", "B"], words });
  s = gameReducer(gameReducer(s, { type: "CONTINUE" }), { type: "PICK", wordId: words[0].id });
  return used ? gameReducer(s, { type: "ILLUSTRATION_USED" }) : s;
};

describe("the illustration request UI", () => {
  it("starts as a plain button: no confirmation shown, no request made, no picture", () => {
    const onRequest = vi.fn(async () => ({ ok: true as const }));
    const html = renderToStaticMarkup(h(IllustrationRequest, { onRequest }));
    expect(html).toContain("I need an illustration");
    expect(html).not.toContain("reduce the available score");
    expect(html).not.toContain("Show illustration");
    expect(onRequest).not.toHaveBeenCalled();
  });
  it("the paid request is wired only to the confirm button (source check)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./IllustrationHint.tsx", import.meta.url), "utf8");
    expect(src).toContain("An illustration will reduce the available score to {max} points.");
    expect(src.match(/onRequest\(\)/g)).toHaveLength(1); // called once, inside go()
    expect(src).toMatch(/onClick=\{go\}>Show illustration/);
    expect(src).toMatch(/onClick=\{\(\) => \{ setError\(null\); setStep\("confirm"\); \}\}/); // the first button only opens the confirmation
  });
  it("GiverPicture shows nothing until used, then the picture", () => {
    expect(renderToStaticMarkup(h(GiverPicture, { used: false, illustration: { src: "data:image/jpeg;base64,QUJD" } }))).toBe("");
    expect(renderToStaticMarkup(h(GiverPicture, { used: true, illustration: { src: "data:image/jpeg;base64,QUJD" } }))).toContain("<img");
    expect(renderToStaticMarkup(h(GiverPicture, { used: true }))).not.toContain("<img");
  });
});

describe("Giver screen", () => {
  const render = (s: ReturnType<typeof roundState>, withButton = true) =>
    renderToStaticMarkup(h(GiverRound, { state: s, dispatch: () => undefined, ...(withButton ? { onRequestIllustration: async () => ({ ok: true as const }) } : {}) }));
  it("does not show a Studio-made picture at the start of the round, but offers the last-resort button", () => {
    const html = render(roundState(false, true));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("base64");
    expect(html).toContain("I need an illustration");
  });
  it("shows the picture and the reduced score only after it has been requested, and hides the button", () => {
    const html = render(roundState(true, true));
    expect(html).toContain("<img");
    expect(html).not.toContain("I need an illustration");
    expect(html).toContain("illustration used");
  });
  it("has no button where no requester is provided", () => {
    expect(render(roundState(false, false), false)).not.toContain("I need an illustration");
  });
});

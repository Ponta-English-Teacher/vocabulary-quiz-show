import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE_SET } from "@/data/vocab";
import { SetPanel } from "./SetPanel";
import type { StudioSet } from "@/lib/studio/types";

const noop = () => undefined;
const render = (set: StudioSet) =>
  renderToStaticMarkup(h(SetPanel, {
    sets: [set], activeId: set.id, busy: null, busyWordId: null, canGenerate: true, onSelect: noop, onAddSet: noop, onRemoveSet: noop, onEdit: noop,
    onToggleLock: noop, onReplace: noop, onNewHints: noop, onIllustrate: noop, onIllustrateAll: noop, onRemoveIllustration: noop, onRegenerateSet: noop,
    onFill: noop, onApprove: noop, onReopen: noop, onRetryMissing: noop, onDropMissing: noop, onPlay: noop, approveProblems: [],
  }));
const words = SAMPLE_SET.words.slice(0, 7).map((w, i) => ({ ...w, id: `x${i}` }));

describe("generation progress in the lineup", () => {
  it("shows approved, written and failed counts and names each missing word with its reason and a retry button", () => {
    const html = render({ id: "s", title: "Set 1", status: "draft", words, lockedIds: [], requested: 9, missing: [
      { word: "ladle", reason: "Hint 1 is too generic.", index: 5 }, { word: "tongs", reason: "The AI did not return an item for this word.", index: 8 }] });
    expect(html).toMatch(/<b>9<\/b> approved/);
    expect(html).toMatch(/<b>7<\/b> written/);
    expect(html).toMatch(/<b[^>]*>2<\/b> failed/);
    expect(html).toContain("“ladle”");
    expect(html).toContain("Hint 1 is too generic.");
    expect(html).toContain("“tongs”");
    expect(html).toContain("Retry this word");
    expect(html).toContain("Remove it from the set");
  });
  it("a complete set shows 9 · 9 · 0 and no retry buttons; an old set shows no banner", () => {
    const nine = SAMPLE_SET.words.slice(0, 9).map((w, i) => ({ ...w, id: `y${i}` }));
    const done = render({ id: "s", title: "Set 1", status: "draft", words: nine, lockedIds: [], requested: 9 });
    expect(done).toMatch(/<b>9<\/b> approved · <b>9<\/b> written · <b[^>]*>0<\/b> failed/);
    expect(done).not.toContain("Retry this word");
    expect(render({ id: "s", title: "Old", status: "approved", words, lockedIds: [] })).not.toContain("Generation progress");
  });
});

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatPanel } from "./ChatPanel";
import { CandidateEditor } from "./CandidateEditor";
import { EMPTY_BRIEF, type Brief } from "@/lib/studio/types";

const brief: Brief = {
  ...EMPTY_BRIEF, topic: "Kitchen tools", level: "B1", approvalPending: true,
  candidates: ["knife", "whisk", "rolling pin"],
  candidateBands: { familiar: ["knife"], moderate: ["whisk"], unfamiliar: [] },
};

describe("candidate list UI", () => {
  it("shows the count and, for every word, Edit / Replace / Delete, plus an Add box", () => {
    const html = renderToStaticMarkup(h(CandidateEditor, { brief, busy: false, onChange: () => undefined }));
    expect(html).toContain("3 words");
    for (const w of brief.candidates) for (const verb of ["Edit", "Replace", "Delete"]) expect(html).toContain(`aria-label="${verb} ${w}"`);
    expect(html).toContain("Add word");
    expect(html).toContain("Your words"); // the hand-typed word sits outside the AI's groups
    expect(html).toContain("Nothing is regenerated");
  });
  it("the chat stays available next to the list and Generate names the number of words", () => {
    const html = renderToStaticMarkup(h(ChatPanel, { messages: [], brief, onCandidates: () => undefined, busy: null, canGenerate: true, setsLabel: "1 set", onSend: () => undefined, onGenerate: () => undefined }));
    expect(html).toContain("Message to the AI producer");
    expect(html).toContain("Generate from my 3 words");
    expect(html).toContain("Candidate words");
  });
  it("without candidates there is no list and Generate keeps its normal label", () => {
    const html = renderToStaticMarkup(h(ChatPanel, { messages: [], brief: EMPTY_BRIEF, onCandidates: () => undefined, busy: null, canGenerate: false, setsLabel: "1 set", onSend: () => undefined, onGenerate: () => undefined }));
    expect(html).not.toContain("Candidate words");
    expect(html).toContain("Generate 1 set");
  });
});

"use client";

import { useRef, useState } from "react";
import type { VocabSet, VocabWord } from "@/data/vocab";
import { callStudio, StudioClientError } from "@/lib/studio/ai/client";
import type { StudioData, StudioRequest } from "@/lib/studio/ai/types";
import {
  addSet, allTargetForms, renameSet, appendWords, applyAiHints, protectedHints, approveSet, dropMissing, fillMissing, noteMissingFailure, regenerateSet, reopenSet, removeSet, renameActivity,
  replaceWord, setBrief, setIllustration, splitApproved, toggleLock, toVocabSet, updateWord,
} from "@/lib/studio/ops";
import { normalize } from "@/lib/answer";
import { getBrowserStorage, saveActivity } from "@/lib/studio/storage";
import { requestIllustration } from "@/lib/studio/illustrateClient";
import { SET_SIZE, type Activity, type Brief, type StudioCommand } from "@/lib/studio/types";
import { ChatPanel } from "./ChatPanel";
import { SetPanel } from "./SetPanel";
import { listKey } from "@/lib/studio/library";
import { restrictionsFor, withRestrictionNote } from "@/lib/studio/restrictions";
import { Notice, StorageNotice, type AiStatus } from "./shared";

type ReqOf<T extends StudioData["task"]> = Extract<StudioRequest, { task: T }>;

export function Workshop({
  initial,
  initialSetId,
  ai,
  onBack,
  onSaved,
  onPlay,
}: {
  initial: Activity;
  /** Open with this set selected (from the Vocabulary Library's Edit button). */
  initialSetId?: string;
  ai: AiStatus;
  onBack: () => void;
  onSaved: () => void;
  onPlay: (set: VocabSet) => void;
}) {
  const [activity, setActivity] = useState(initial);
  // Always-current copy: async AI replies are applied to THIS, so they never clobber edits made meanwhile.
  const actRef = useRef(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyWordId, setBusyWordId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [activeSetId, setActiveSetId] = useState<string | null>(initial.sets.find((s) => s.id === initialSetId)?.id ?? initial.sets[0]?.id ?? null);
  const [tab, setTab] = useState<"chat" | "sets">(initial.sets.length ? "sets" : "chat");
  const [approveProblems, setApproveProblems] = useState<string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  const commit = (next: Activity) => {
    actRef.current = next;
    setActivity(next);
    setDirty(true);
    setSavedAt(false);
    setApproveProblems([]);
  };

  const call = <T extends StudioData["task"]>(task: T, params: Omit<ReqOf<T>, "task" | "forceMock">) =>
    callStudio(task, { ...params, forceMock: ai.forceMock });

  const aiSay = (text: string) => commit({ ...actRef.current, messages: [...actRef.current.messages, { role: "ai", text }] });
  const fail = (e: unknown) =>
    setNotice({ kind: "error", text: e instanceof StudioClientError ? e.message : "Something went wrong. Nothing was changed." });

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      setBusyWordId(null);
    }
  };

  const findWord = (setId: string, wordId: string): VocabWord | undefined =>
    actRef.current.sets.find((s) => s.id === setId)?.words.find((w) => w.id === wordId);

  /** An approved set only changes after the teacher presses "Reopen for editing". */
  const frozen = (setId: string): boolean => {
    if (actRef.current.sets.find((s) => s.id === setId)?.status !== "approved") return false;
    setNotice({ kind: "info", text: "This set is approved, so it hasn't been changed. Press “Reopen for editing” first if you want to change it." });
    return true;
  };

  // ---- AI operations (each touches only what it names) -----------------------------

  const doGenerate = async (brief: Brief, n: number, instruction?: string) => {
    let made = 0;
    let failedAll = false;
    // Words the teacher approved are used exactly, ten per set; anything left over goes to the next set.
    const chunks = splitApproved(brief.approvedWords);
    const total = Math.max(n, chunks.length);
    for (let i = 0; i < total; i++) {
      setBusy(total > 1 ? `Writing set ${i + 1} of ${total}` : "Writing your set");
      const exclude = allTargetForms(actRef.current);
      const approved = chunks[i] ?? [];
      // A teacher-approved list is written exactly as it is: a short list makes a short set (no padding with words the teacher never chose).
      const want = approved.length || SET_SIZE;
      const { data } = await call("generate", { brief, count: want, exclude, approved, instruction });
      if (data.words.length === 0) {
        setNotice({ kind: "error", text: data.issues[0] ?? "No usable words came back. Nothing was changed." });
        failedAll = true;
        break;
      }
      // Every approved word is accounted for: written, or recorded as missing WITH the reason. Nothing disappears silently.
      const missing = (data.failed ?? []).map((f) => ({ word: f.word, reason: f.reason, index: Math.max(0, approved.findIndex((x) => normalize(x) === normalize(f.word))) }));
      const flagged = data.flagged ?? [];
      const next = addSet(actRef.current, data.words, approved.length ? { requested: approved.length, missing, flaggedWords: flagged.map((f) => f.word) } : {});
      commit(next);
      setActiveSetId(next.sets[next.sets.length - 1].id);
      made++;
      if (missing.length || flagged.length) {
        const parts = [
          ...flagged.map((f) => `“${f.word}” is in your set, but ${f.hints.length ? `hint${f.hints.length === 1 ? "" : "s"} ${f.hints.map((h) => h + 1).join(", ")}` : "its hints"} still need${f.hints.length === 1 ? "s" : ""} correcting — ${f.reason}`),
          ...missing.map((m) => `“${m.word}” has no item yet — ${m.reason}`),
        ];
        setNotice({
          kind: "error",
          text: `All ${approved.length} of your words are kept. ${data.words.length - flagged.length} are complete; ${parts.length} need${parts.length === 1 ? "s" : ""} attention. ${parts.join(" ")} Edit the hints yourself, or use “Rewrite hints” / “Retry this word” on the lineup. The set can't be approved until each is fixed.`,
        });
      } else if (data.words.length < want) {
        setNotice({
          kind: "error",
          text: `I asked for ${want} words and ${data.words.length} came back valid for Set ${next.sets.length}. ${data.issues.length} item${data.issues.length === 1 ? " was" : "s were"} rejected along the way. ${data.issues.slice(0, 2).join(" ")} The set is fine as it is (a set can have 1–${SET_SIZE} words); ask the AI for more, or add words by hand.`,
        });
      }
    }
    // The approved list now lives in the set (written items plus any recorded as missing), so the candidate list can be cleared.
    // If nothing could be written at all, the list is KEPT so the teacher can simply try again.
    if (failedAll && made === 0) return;
    if (brief.approvedWords.length || brief.candidates.length || brief.pinnedCandidates.length || brief.removedCandidates.length) {
      // The approved list has been used; don't let it leak into later "add set" requests.
      commit(setBrief(actRef.current, { ...actRef.current.brief, approvedWords: [], candidates: [], candidateBands: { familiar: [], moderate: [], unfamiliar: [] }, pinnedCandidates: [], removedCandidates: [], approvalPending: false }));
    }
    if (made > 0) {
      setTab("sets");
      aiSay(`Here ${made === 1 ? "is your set" : `are your ${made} sets`}. Skim every word, open any item to edit it, and approve when you're happy. Tell me what to change — for example “replace #4 with something less common”.`);
    }
  };

  /** Retry ONE missing word. The words already written are not touched or regenerated. */
  const doRetryMissing = async (setId: string, word: string) => {
    setBusy(`Writing “${word}”`);
    const { data } = await call("generate", { brief: actRef.current.brief, count: 1, exclude: allTargetForms(actRef.current), approved: [word] });
    const item = data.words[0];
    if (!item) {
      const reason = data.failed?.[0]?.reason ?? data.issues[0] ?? "The AI did not return a usable item.";
      commit(noteMissingFailure(actRef.current, setId, word, reason));
      return setNotice({ kind: "error", text: `Still no item for “${word}” — ${reason} Everything else is unchanged. You can try again or remove it from the set.` });
    }
    const r = fillMissing(actRef.current, setId, word, item);
    if (r.error) return setNotice({ kind: "error", text: r.error });
    commit(r.activity);
    setNotice({ kind: "info", text: `Wrote “${word}”. The other words weren't touched.` });
  };

  const doReplace = async (setId: string, wordId: string, instruction?: string) => {
    const word = findWord(setId, wordId);
    if (!word) return setNotice({ kind: "error", text: "That word no longer exists." });
    setBusy("Finding a replacement");
    setBusyWordId(wordId);
    const { data } = await call("replace-word", { brief: actRef.current.brief, current: word, exclude: allTargetForms(actRef.current), instruction: instruction || undefined,
    });
    const r = replaceWord(actRef.current, setId, wordId, data.word);
    if (r.error) return setNotice({ kind: "error", text: r.error });
    commit(r.activity);
    setNotice({ kind: "info", text: `Replaced “${word.word}” with “${data.word.word}”. The other words weren't touched.` });
  };

  const doHints = async (setId: string, wordId: string, instruction?: string, only?: number[]) => {
    const word = findWord(setId, wordId);
    const set = actRef.current.sets.find((x) => x.id === setId);
    if (!word || !set) return setNotice({ kind: "error", text: "That word no longer exists." });
    // Hints the teacher wrote themselves are never overwritten by the AI. Clearing a hint hands it back.
    const mine = protectedHints(set, word);
    const open = [0, 1, 2].filter((i) => !mine.includes(i) && (!only || only.includes(i)));
    if (!open.length) return setNotice({ kind: "info", text: `The hint${mine.length === 1 ? "" : "s"} to change ${mine.length === 1 ? "is" : "are"} your own wording, so I left ${mine.length === 1 ? "it" : "them"} alone. Edit ${mine.length === 1 ? "it" : "them"} yourself, or clear ${mine.length === 1 ? "it" : "them"} and ask again.` });
    setBusy("Writing new hints");
    setBusyWordId(wordId);
    const { data } = await call("regenerate-hints", { brief: actRef.current.brief, word, instruction: instruction || undefined });
    const r = applyAiHints(actRef.current, setId, wordId, data.hints, only);
    commit(r.activity);
    const nums = (l: number[]) => l.map((i) => i + 1).join(", ");
    setNotice({ kind: "info", text: `New hint${r.changed.length === 1 ? "" : "s"} (${nums(r.changed)}) for “${word.word}”.${r.kept.length ? ` Your own hint${r.kept.length === 1 ? "" : "s"} ${nums(r.kept)} ${r.kept.length === 1 ? "was" : "were"} kept.` : ""} Nothing else changed.` });
  };

  /** Draw one picture for one word. A failure is reported and changes nothing: the word stays playable without a picture. */
  const drawOne = async (setId: string, wordId: string): Promise<string | null> => {
    const word = findWord(setId, wordId);
    if (!word) return "That word no longer exists.";
    setBusyWordId(wordId);
    const r = await requestIllustration(word);
    if (!r.ok) return r.message;
    commit(setIllustration(actRef.current, setId, wordId, r.illustration));
    return null;
  };

  const doIllustrate = async (setId: string, wordId: string) => {
    setBusy("Drawing a picture");
    const err = await drawOne(setId, wordId);
    const word = findWord(setId, wordId);
    setNotice(err ? { kind: "error", text: `No picture for “${word?.word ?? "this word"}”: ${err} The word is still playable without one.` } : { kind: "info", text: `New picture for “${word?.word}”. Nothing else changed.` });
  };

  /** One picture per word that has none yet, one at a time (keeps the cost visible and the failures separate). */
  const doIllustrateAll = async (setId: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    const todo = set.words.filter((w) => !w.illustration).map((w) => w.id);
    const failed: string[] = [];
    let first = "";
    for (let i = 0; i < todo.length; i++) {
      setBusy(`Drawing picture ${i + 1} of ${todo.length}`);
      const err = await drawOne(setId, todo[i]);
      if (err) {
        failed.push(findWord(setId, todo[i])?.word ?? "?");
        first ||= err;
        if (/OpenAI key|passcode|unauthor/i.test(err)) break; // every remaining word would fail the same way
      }
    }
    setNotice(
      failed.length
        ? { kind: "error", text: `${todo.length - failed.length} of ${todo.length} pictures drawn. No picture for: ${failed.join(", ")}. ${first} Those words are still playable without one; use “Draw picture” on a word to try again.` }
        : { kind: "info", text: `${todo.length} picture${todo.length === 1 ? "" : "s"} drawn. Only the Giver will ever see them.` },
    );
  };

  const doRegenSet = async (setId: string, instruction?: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    const open = set.words.filter((w) => !set.lockedIds.includes(w.id)).length;
    if (open === 0) return setNotice({ kind: "info", text: "Every word in this set is locked, so there's nothing to regenerate." });
    setBusy("Regenerating the set");
    const { data } = await call("generate", { brief: actRef.current.brief, count: open, exclude: allTargetForms(actRef.current), instruction,
    });
    const r = regenerateSet(actRef.current, setId, data.words);
    commit(r.activity);
    setNotice({ kind: "info", text: `${r.replaced} word${r.replaced === 1 ? "" : "s"} replaced${set.lockedIds.length ? `; ${set.lockedIds.length} locked kept` : ""}.` });
  };

  const doFill = async (setId: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    setBusy("Finding more words");
    const { data } = await call("generate", { brief: actRef.current.brief, count: SET_SIZE - set.words.length, exclude: allTargetForms(actRef.current),
    });
    const next = appendWords(actRef.current, setId, data.words);
    commit(next);
    const have = next.sets.find((x) => x.id === setId)?.words.length ?? 0;
    if (have < SET_SIZE) {
      setNotice({ kind: "error", text: `Still ${SET_SIZE - have} short (${have}/${SET_SIZE}). ${data.issues.slice(0, 2).join(" ")} You can try again or add words by hand.` });
    }
  };

  const runCommand = async (cmd: StudioCommand, brief: Brief) => {
    // A one-off instruction that contains a checkable restriction is remembered, so it is still enforced when the teacher edits or approves.
    if ("instruction" in cmd && cmd.instruction) {
      const focus = withRestrictionNote(actRef.current.brief.learnerFocus, cmd.instruction);
      if (focus !== actRef.current.brief.learnerFocus) commit(setBrief(actRef.current, { ...actRef.current.brief, learnerFocus: focus }));
    }
    const set = actRef.current.sets.find((s) => s.id === activeSetId) ?? actRef.current.sets[0];
    if (cmd.type === "generate") return doGenerate(brief, brief.numSets);
    if (!set) return setNotice({ kind: "info", text: "Generate a set first, then I can change it." });
    if (frozen(set.id)) return;
    if (cmd.type === "regenerate-set") return doRegenSet(set.id, cmd.instruction);
    const word = set.words[cmd.position - 1];
    if (!word) return setNotice({ kind: "error", text: `There is no word #${cmd.position} in this set.` });
    return cmd.type === "replace-word" ? doReplace(set.id, word.id, cmd.instruction) : doHints(set.id, word.id, cmd.instruction);
  };

  const sendChat = (text: string) =>
    run("Thinking", async () => {
      const messages = [...actRef.current.messages, { role: "teacher" as const, text }];
      commit({ ...actRef.current, messages });
      const set = actRef.current.sets.find((s) => s.id === activeSetId) ?? actRef.current.sets[0];
      const context = set ? { words: set.words.map((w, i) => ({ position: i + 1, word: w.word, cefr: w.cefr })) } : undefined;
      const { data } = await call("chat", { messages, brief: actRef.current.brief, context });
      const r = data.result;
      commit(setBrief({ ...actRef.current, messages: [...actRef.current.messages, { role: "ai", text: r.reply }] }, r.brief));
      if (r.command) await runCommand(r.command, r.brief);
    });

  // ---- manual edits & housekeeping -------------------------------------------------

  const save = (): boolean => {
    const res = saveActivity(getBrowserStorage(), actRef.current);
    if (!res.ok) {
      setNotice({ kind: "error", text: res.error });
      return false;
    }
    setDirty(false);
    setSavedAt(true);
    onSaved();
    return true;
  };

  const play = (setId: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    save();
    onPlay(toVocabSet(actRef.current, set));
  };

  const brief = activity.brief;
  const canGenerate = brief.topic.trim().length > 0;
  const setsLabel = `${brief.numSets} set${brief.numSets === 1 ? "" : "s"}`;

  return (
    <section className="workshop" aria-label="Activity workshop">
      <div className="ws-bar">
        {leaving ? (
          <span className="confirm" role="group" aria-label="Unsaved changes">
            <span className="confirm__text">You have unsaved changes.</span>
            <button type="button" className="btn btn--small" onClick={() => { if (save()) onBack(); }}>Save &amp; leave</button>
            <button type="button" className="btn btn--small btn--danger" onClick={onBack}>Leave without saving</button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setLeaving(false)}>Stay</button>
          </span>
        ) : (
          <button type="button" className="btn btn--link" onClick={() => (dirty ? setLeaving(true) : onBack())}>‹ All activities</button>
        )}
        <label className="titlefld">
          <span className="sr-only">Activity title</span>
          <input value={activity.title} onChange={(e) => commit(renameActivity(actRef.current, e.target.value))} maxLength={80} />
        </label>
        <div className="ws-save">
          <span className="ws-status" aria-live="polite">{dirty ? "Unsaved changes" : savedAt ? "Saved ✓" : ""}</span>
          <button type="button" className="btn btn--small btn--save" onClick={save} disabled={!dirty && savedAt}>Save</button>
        </div>
      </div>

      {notice ? <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice> : null}

      <div className="tabswitch" role="tablist" aria-label="Workshop view">
        <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Writers&apos; room</button>
        <button type="button" role="tab" aria-selected={tab === "sets"} onClick={() => setTab("sets")}>
          The lineup{activity.sets.length ? ` (${activity.sets.length})` : ""}
        </button>
      </div>

      <div className="workshop__grid" data-tab={tab}>
        <ChatPanel
          messages={activity.messages}
          brief={brief}
          onCandidates={(b) => commit(setBrief(actRef.current, b))}
          busy={busy}
          canGenerate={canGenerate}
          setsLabel={setsLabel}
          onSend={sendChat}
          onGenerate={() => run("Writing your set", async () => {
            // Pressing Generate is the teacher's approval: release any "discuss first" hold.
            const cur = actRef.current.brief;
            // Clicking Generate while candidates are on the table approves exactly those candidates (including the teacher's own edits).
            const brief = {
              ...cur,
              approvalPending: false,
              approvedWords: cur.candidates.length ? cur.candidates : cur.approvedWords,
            };
            commit(setBrief(actRef.current, brief));
            await doGenerate(brief, brief.numSets);
          })}
        />
        <SetPanel
          sets={activity.sets}
          activeId={activeSetId}
          busy={busy}
          restrictions={restrictionsFor(brief.learnerFocus)}
          busyWordId={busyWordId}
          canGenerate={canGenerate}
          onSelect={(id) => { setActiveSetId(id); setApproveProblems([]); }}
          onRenameSet={(s, t) => commit(renameSet(actRef.current, s, t))}
          shareFor={(s) => ({ source: listKey(actRef.current.id, s), title: `${actRef.current.title} — ${actRef.current.sets.find((x) => x.id === s)?.title.trim() || "Set"}` })}
          onAddSet={() => run("Writing another set", () => doGenerate(actRef.current.brief, 1))}
          onRemoveSet={(id) => {
            const next = removeSet(actRef.current, id);
            commit(next);
            setActiveSetId(next.sets[0]?.id ?? null);
          }}
          onEdit={(s, w, patch) => { if (!frozen(s)) commit(updateWord(actRef.current, s, w, patch)); }}
          onToggleLock={(s, w) => commit(toggleLock(actRef.current, s, w))}
          onReplace={(s, w, ins) => { if (!frozen(s)) void run("Finding a replacement", () => doReplace(s, w, ins)); }}
          onNewHints={(s, w, ins, only) => { if (!frozen(s)) void run("Writing new hints", () => doHints(s, w, ins, only)); }}
          onIllustrate={(s, w) => run("Drawing a picture", () => doIllustrate(s, w))}
          onIllustrateAll={(s) => run("Drawing pictures", () => doIllustrateAll(s))}
          onRemoveIllustration={(s, w) => commit(setIllustration(actRef.current, s, w, undefined))}
          onRegenerateSet={(s) => { if (!frozen(s)) void run("Regenerating the set", () => doRegenSet(s)); }}
          onFill={(s) => { if (!frozen(s)) void run("Finding more words", () => doFill(s)); }}
          onRetryMissing={(s, word) => { if (!frozen(s)) void run(`Writing “${word}”`, () => doRetryMissing(s, word)); }}
          onDropMissing={(s, word) => { if (!frozen(s)) commit(dropMissing(actRef.current, s, word)); }}
          onReopen={(s) => { commit(reopenSet(actRef.current, s)); setNotice({ kind: "info", text: "Reopened. You can edit this set now; approve it again when you're happy." }); }}
          onApprove={(s) => {
            const r = approveSet(actRef.current, s);
            if (r.problems.length) return setApproveProblems(r.problems);
            commit(r.activity);
          }}
          onPlay={play}
          approveProblems={approveProblems}
        />
      </div>

      <StorageNotice />
    </section>
  );
}

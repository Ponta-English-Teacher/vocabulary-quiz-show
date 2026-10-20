import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSpeakingId, pickVoice, prepareSpeech, RATES, speakText, stopSpeaking, subscribeSpeech, type VoiceLike } from "./speech";

const v = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({ name, lang, ...extra });

describe("voice choice", () => {
  it("prefers natural/enhanced and well-known clear English voices over plain defaults", () => {
    const voices = [v("Some Default", "en-US", { default: true }), v("Samantha", "en-US", { localService: true }), v("Microsoft Aria Online (Natural)", "en-US")];
    expect(pickVoice(voices)?.name).toBe("Microsoft Aria Online (Natural)");
    expect(pickVoice([v("Some Default", "en-US", { default: true }), v("Samantha", "en-US", { localService: true })])?.name).toBe("Samantha");
  });
  it("only chooses English voices, preferring US then UK, and never novelty voices", () => {
    expect(pickVoice([v("Kyoko", "ja-JP"), v("Amelie", "fr-CA")])).toBeNull();
    expect(pickVoice([v("Daniel", "en-GB", { localService: true }), v("Plain", "en-US")])?.name).toBe("Daniel");
    expect(pickVoice([v("Zarvox", "en-US"), v("Bad News", "en-US"), v("Albert", "en-US"), v("Fred", "en-US")])).toBeNull();
    expect(pickVoice([v("Zarvox", "en-US"), v("Karen", "en-AU")])?.name).toBe("Karen");
    expect(pickVoice([])).toBeNull();
  });
  it("copes with underscore language tags (some Android voices)", () => {
    expect(pickVoice([v("Google US English", "en_US")])?.name).toBe("Google US English");
  });
});

describe("voice choice on a real Mac voice list (captured from Chrome on macOS)", () => {
  const mac = [
    ["Albert", "en-US"], ["Bad News", "en-US"], ["Bahh", "en-US"], ["Boing", "en-US"], ["Bubbles", "en-US"], ["Cellos", "en-US"],
    ["Daniel", "en-GB"], ["Eddy (英語（アメリカ合衆国）)", "en-US"], ["Flo (英語（アメリカ合衆国）)", "en-US"], ["Fred", "en-US"],
    ["Good News", "en-US"], ["Grandma (英語（アメリカ合衆国）)", "en-US"], ["Junior", "en-US"], ["Karen", "en-AU"], ["Kathy", "en-US"],
    ["Moira", "en-IE"], ["Ralph", "en-US"], ["Rishi", "en-IN"], ["Samantha", "en-US"], ["Tessa", "en-ZA"], ["Zarvox", "en-US"],
    ["Kyoko", "ja-JP"], ["ささやき声", "en-US"],
  ].map(([name, lang]) => v(name, lang, { localService: true }));
  it("picks Samantha — not Albert, the novelty voice the old 'first English voice' rule would have chosen", () => {
    expect(mac.find((x) => x.lang.startsWith("en"))?.name).toBe("Albert"); // what the previous code used
    expect(pickVoice(mac)?.name).toBe("Samantha");
  });
  it("still finds a good voice if Samantha is missing", () => {
    expect(pickVoice(mac.filter((x) => x.name !== "Samantha"))?.name).toBe("Daniel");
  });
});

describe("text prepared for speech", () => {
  it("reads blanks as 'blank' instead of 'underscore'", () => {
    expect(prepareSpeech("Unlike a bowl, a ____ is made for one task.")).toBe("Unlike a bowl, a, blank, is made for one task.");
  });
  it("straightens quotes and spacing", () => {
    expect(prepareSpeech("  It’s   a “tool”  ")).toBe('It\'s a "tool"');
  });
});

// ---- a fake speechSynthesis to prove there is never overlapping playback -----------------------------------------
class FakeUtterance {
  voice: unknown = null; lang = ""; rate = 1; pitch = 1; volume = 1;
  onend: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
function installFakeSynth(voices: VoiceLike[] = [v("Samantha", "en-US", { localService: true })]) {
  const log = { spoken: [] as FakeUtterance[], cancels: 0 };
  const active: { current: FakeUtterance | null } = { current: null };
  const synth = {
    speaking: false, pending: false,
    getVoices: () => voices,
    addEventListener: () => {},
    speak(u: FakeUtterance) { log.spoken.push(u); active.current = u; synth.speaking = true; },
    cancel() { log.cancels++; active.current = null; synth.speaking = false; synth.pending = false; },
  };
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return { synth, log, active, finish: () => { const u = active.current; synth.speaking = false; active.current = null; u?.onend?.(); } };
}

describe("playback never overlaps", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { stopSpeaking(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("speaks with the chosen voice, language and rate", () => {
    const { log } = installFakeSynth();
    expect(speakText("umbrella", { id: "word", rate: RATES.word })).toBe(true);
    expect(log.spoken).toHaveLength(1);
    const u = log.spoken[0];
    expect(u.text).toBe("umbrella");
    expect((u.voice as VoiceLike).name).toBe("Samantha");
    expect(u.lang).toBe("en-US");
    expect(u.rate).toBe(0.85);
    expect(getSpeakingId()).toBe("word");
  });
  it("starting a new utterance cancels the one in progress — only the newest is active", () => {
    const { log, active } = installFakeSynth();
    speakText("first", { id: "a" });
    vi.advanceTimersByTime(200);
    speakText("second", { id: "b" });
    vi.advanceTimersByTime(200);
    expect(log.cancels).toBeGreaterThanOrEqual(2);
    expect(active.current?.text).toBe("second");
    expect(getSpeakingId()).toBe("b");
  });
  it("an older request scheduled behind a busy synth never plays after a newer one", () => {
    const { log, synth } = installFakeSynth();
    synth.speaking = true; // something is already playing → the next start is delayed
    speakText("old", { id: "a" });
    speakText("new", { id: "b" }); // supersedes before the delay elapses
    vi.advanceTimersByTime(500);
    expect(log.spoken.map((u) => u.text)).toEqual(["new"]);
  });
  it("pressing the same button again stops playback (toggle)", () => {
    const { log, active } = installFakeSynth();
    speakText("umbrella", { id: "word" });
    expect(speakText("umbrella", { id: "word" })).toBe(false);
    expect(active.current).toBeNull();
    expect(getSpeakingId()).toBeNull();
    expect(log.spoken).toHaveLength(1);
  });
  it("a finished utterance clears the playing state, but a stale 'end' from a cancelled one does not", () => {
    const { log, finish } = installFakeSynth();
    speakText("one", { id: "a" });
    const first = log.spoken[0];
    speakText("two", { id: "b" });
    vi.advanceTimersByTime(200);
    first.onend?.(); // late callback from the cancelled utterance
    expect(getSpeakingId()).toBe("b");
    finish();
    expect(getSpeakingId()).toBeNull();
  });
  it("stopSpeaking cancels playback and anything still scheduled", () => {
    const { log, synth } = installFakeSynth();
    synth.speaking = true;
    speakText("pending", { id: "a" });
    stopSpeaking();
    vi.advanceTimersByTime(500);
    expect(log.spoken).toHaveLength(0);
    expect(getSpeakingId()).toBeNull();
  });
  it("notifies listeners so buttons can show Stop, and is silent when speech is unavailable", () => {
    const { finish } = installFakeSynth();
    const seen: (string | null)[] = [];
    const off = subscribeSpeech(() => seen.push(getSpeakingId()));
    speakText("hello", { id: "x" });
    finish();
    off();
    expect(seen).toEqual(["x", null]);
    vi.unstubAllGlobals();
    vi.stubGlobal("window", {});
    expect(speakText("hello", { id: "y" })).toBe(false);
  });
  it("ignores empty text", () => {
    const { log } = installFakeSynth();
    expect(speakText("   ", { id: "e" })).toBe(false);
    expect(log.spoken).toHaveLength(0);
  });
});

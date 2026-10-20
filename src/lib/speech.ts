/**
 * Pronunciation through the browser's built-in speech synthesis — free, works offline, no API keys.
 *
 * Reliability notes (why this is more than `speechSynthesis.speak`):
 *  - Voices differ a lot per device. `pickVoice` ranks them: natural/enhanced/premium voices and well-known
 *    good ones first, English (US/UK) before other accents, novelty voices never.
 *  - Only ONE utterance plays at a time. Starting a new one cancels the old one; pressing the same
 *    button again stops it (toggle). Stale timers can't start a cancelled utterance.
 *  - Chrome sometimes drops a `speak()` issued right after `cancel()`, so a short gap is used then.
 *  - iOS Safari only speaks after a user tap — every caller is a button.
 */

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess)\b/i;
const QUALITY = /\b(natural|neural|premium|enhanced|online)\b/i;
const PREFERRED = [
  "samantha", "ava", "allison", "susan", "daniel", "karen", "serena", "moira", "tessa", "alex",
  "google us english", "google uk english", "aria", "jenny", "guy", "libby", "sonia", "natasha", "ryan", "zira",
];

function scoreVoice(v: VoiceLike): number | null {
  const lang = v.lang.toLowerCase().replace("_", "-");
  if (!lang.startsWith("en")) return null;
  if (NOVELTY.test(v.name)) return null;
  let s = 0;
  if (lang === "en-us") s += 3;
  else if (lang === "en-gb") s += 2;
  else if (/^en-(au|ie|za|ca|nz)/.test(lang)) s += 1;
  if (QUALITY.test(v.name)) s += 6;
  const name = v.name.toLowerCase();
  if (PREFERRED.some((p) => name.includes(p))) s += 4;
  if (v.localService) s += 1; // works offline and starts faster
  if (v.default) s += 1;
  return s;
}

/** The clearest English voice available on this device (or null → let the browser choose). */
export function pickVoice<T extends VoiceLike>(voices: T[]): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = scoreVoice(v);
    if (s !== null && s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

/** Make written text sound right: "____" blanks are read as "blank", odd spacing is tidied. */
export function prepareSpeech(text: string): string {
  return text
    .replace(/_{2,}/g, ", blank, ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

export const RATES = { word: 0.85, slow: 0.55, hint: 0.95 } as const;

// ---- playback state (shared by all buttons, so nothing overlaps) -------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let currentId: string | null = null;
let token = 0;
let cachedVoice: SpeechSynthesisVoice | null = null;

const notify = () => listeners.forEach((l) => l());
function setCurrent(id: string | null) {
  if (currentId !== id) {
    currentId = id;
    notify();
  }
}

export function subscribeSpeech(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getSpeakingId = (): string | null => currentId;

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

function voiceNow(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) cachedVoice = pickVoice(voices) ?? cachedVoice;
  return cachedVoice;
}

/**
 * Speak `text`. With an `id`, calling again with the same id while it is playing STOPS it (toggle).
 * Returns true if speech was started.
 */
export function speakText(text: string, opts: { rate?: number; id?: string } = {}): boolean {
  if (!speechAvailable()) return false;
  const synth = window.speechSynthesis;
  if (opts.id && currentId === opts.id) {
    stopSpeaking();
    return false;
  }
  const spoken = prepareSpeech(text);
  if (!spoken) return false;

  const mine = ++token;
  const busy = synth.speaking || synth.pending;
  synth.cancel();
  setCurrent(opts.id ?? "anonymous");

  const start = () => {
    if (mine !== token) return; // a newer request (or Stop) superseded this one
    const u = new SpeechSynthesisUtterance(spoken);
    const voice = voiceNow();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "en-US";
    }
    u.rate = opts.rate ?? RATES.word;
    u.pitch = 1;
    u.volume = 1;
    const done = () => {
      if (mine === token) setCurrent(null);
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  };
  if (busy) setTimeout(start, 80);
  else start();
  return true;
}

/** Legacy helper (kept so existing callers keep working). */
export function speak(text: string, rate: number = RATES.word): void {
  speakText(text, { rate });
}

export function stopSpeaking(): void {
  token++; // invalidate anything scheduled
  if (speechAvailable()) window.speechSynthesis.cancel();
  setCurrent(null);
}

// Voices arrive asynchronously in Chrome/Android: refresh the cache when they do.
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    voiceNow();
  });
}

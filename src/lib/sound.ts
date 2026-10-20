/**
 * Sound effects, synthesised live with the Web Audio API — no audio files,
 * no downloads. (Independent of any developer-tool notification sounds.)
 */

export type SoundName =
  | "tap"
  | "hint"
  | "correct"
  | "close"
  | "wrong"
  | "skip"
  | "switch"
  | "drumroll"
  | "fanfare";

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(value: boolean): void {
  muted = value;
}
export function isMuted(): boolean {
  return muted;
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  glideTo?: number;
  attack?: number;
}

function tone(c: AudioContext, freq: number, start: number, dur: number, o: ToneOptions = {}): void {
  const { type = "sine", gain = 0.12, glideTo, attack = 0.01 } = o;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(amp).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

function noiseSweep(c: AudioContext, start: number, dur: number, from: number, to: number, gain = 0.08): void {
  const buffer = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(from, start);
  filter.frequency.exponentialRampToValueAtTime(to, start + dur);
  const amp = c.createGain();
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + dur * 0.5);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter).connect(amp).connect(c.destination);
  src.start(start);
}

// Note frequencies (Hz)
const C4 = 261.63, E4 = 329.63, G4 = 392, A4 = 440;
const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.5;

export function play(name: SoundName): void {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime + 0.02;

  switch (name) {
    case "tap":
      tone(c, 660, t, 0.06, { type: "triangle", gain: 0.05 });
      break;
    case "hint":
      tone(c, 880, t, 0.09, { type: "triangle", gain: 0.07 });
      tone(c, 1320, t + 0.07, 0.12, { type: "sine", gain: 0.05 });
      break;
    case "correct":
      [C5, E5, G5, C6].forEach((f, i) => tone(c, f, t + i * 0.07, 0.35, { type: "triangle", gain: 0.12 }));
      [C5, E5, G5].forEach((f) => tone(c, f, t + 0.3, 0.9, { type: "sine", gain: 0.06, attack: 0.04 }));
      [E6, C6, E6, G5 * 2].forEach((f, i) => tone(c, f, t + 0.32 + i * 0.07, 0.25, { type: "sine", gain: 0.04 }));
      break;
    case "close":
      tone(c, E4, t, 0.18, { type: "triangle", gain: 0.07 });
      tone(c, G4, t + 0.14, 0.28, { type: "triangle", gain: 0.07 });
      break;
    case "wrong":
      // Gentle "aww": a soft, falling two-note sigh — no harsh buzzer.
      tone(c, A4, t, 0.22, { type: "triangle", gain: 0.07 });
      tone(c, E4, t + 0.18, 0.4, { type: "triangle", gain: 0.07, glideTo: C4 });
      break;
    case "skip":
      tone(c, G4, t, 0.3, { type: "sine", gain: 0.06, glideTo: C4 });
      break;
    case "switch":
      noiseSweep(c, t, 0.7, 300, 3200);
      tone(c, G4, t + 0.55, 0.2, { type: "triangle", gain: 0.1 });
      tone(c, C5, t + 0.7, 0.45, { type: "triangle", gain: 0.1 });
      break;
    case "drumroll":
      for (let i = 0; i < 28; i++) {
        noiseSweep(c, t + i * 0.075, 0.07, 180, 260, 0.05 + (i / 28) * 0.07);
      }
      break;
    case "fanfare": {
      const seq: [number, number, number][] = [
        [C5, 0, 0.16], [C5, 0.18, 0.16], [C5, 0.36, 0.16], [G5, 0.54, 0.5], [E5, 1.05, 0.18], [G5, 1.25, 0.9],
      ];
      seq.forEach(([f, o, d]) => {
        tone(c, f, t + o, d, { type: "sawtooth", gain: 0.05 });
        tone(c, f * 2, t + o, d, { type: "triangle", gain: 0.05 });
      });
      [C5, E5, G5, C6].forEach((f) => tone(c, f, t + 1.25, 1.6, { type: "sine", gain: 0.05, attack: 0.05 }));
      break;
    }
  }
}

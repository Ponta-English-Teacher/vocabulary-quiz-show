import { createHash, randomBytes } from "node:crypto";
import { coerceWord } from "@/lib/studio/validation";
import { kvFromEnv, KvConfigError, KvError, type KV } from "@/lib/class/kv";
import type { StudyView, StudyWord } from "./types";

/**
 * Student study pages. A teacher publishes a SNAPSHOT of one vocabulary list; students open it with an unguessable link.
 *
 *  - the link carries a 128-bit random token; storage is keyed by the token's hash, so reading the store never reveals a link
 *  - only study fields are stored: word, part of speech, definition, Japanese meanings, example. Never hints, Giver notes,
 *    pictures, accepted answers, teacher instructions or anything about the activity
 *  - there is no listing: a page can only be read by someone who has its token
 *  - it expires by itself (STUDY_TTL) and the teacher can take it down earlier
 *  - it lives in the same shared store as the classroom (Upstash Redis on Vercel), under its own key prefix
 */

export const STUDY_TTL = 14 * 24 * 60 * 60;
export const MAX_STUDY_WORDS = 50;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const keyOf = (token: string) => `vqs:study:${createHash("sha256").update(token).digest("hex")}`;

export type StudyFail = { ok: false; code: "bad_request" | "not_found" | "unavailable"; message: string };
const fail = (code: StudyFail["code"], message: string): StudyFail => ({ ok: false, code, message });
const NOT_FOUND = "This study link isn't valid, or it has expired or been taken down. Ask your teacher for a new link.";

/** The study fields of a word, and nothing else. */
export function toStudyWord(w: { word: string; partOfSpeech: string; meaning: string; example: string; ja?: string[] }): StudyWord {
  return { word: w.word, partOfSpeech: w.partOfSpeech, meaning: w.meaning, ja: (w.ja ?? []).filter((j) => j.trim()), example: w.example.trim() };
}

export class StudyService {
  private resolved: KV | null = null;
  constructor(private source: KV | (() => KV), private now: () => number = Date.now) {}
  private get kv(): KV {
    return (this.resolved ??= typeof this.source === "function" ? this.source() : this.source);
  }
  private async guard<T>(fn: () => Promise<T>): Promise<T | StudyFail> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof KvConfigError) return fail("unavailable", "Study pages aren't set up on this server yet.");
      if (e instanceof KvError) return fail("unavailable", "Study pages are temporarily unavailable. Please try again.");
      throw e;
    }
  }

  async publish(input: { title: unknown; words: unknown }): Promise<{ ok: true; token: string; expiresAt: number } | StudyFail> {
    if (typeof input.title !== "string" || !input.title.trim() || !Array.isArray(input.words) || input.words.length < 1 || input.words.length > MAX_STUDY_WORDS) {
      return fail("bad_request", `A study page needs a title and 1–${MAX_STUDY_WORDS} words.`);
    }
    const words: StudyWord[] = [];
    for (const raw of input.words) {
      const c = coerceWord(raw, { id: "study" });
      if (!("word" in c)) return fail("bad_request", "One of the words is invalid.");
      words.push(toStudyWord(c.word));
    }
    const token = randomBytes(16).toString("base64url");
    const expiresAt = this.now() + STUDY_TTL * 1000;
    const view: StudyView = { title: input.title.trim().slice(0, 80), words, expiresAt };
    const r = await this.guard(async () => {
      await this.kv.set(keyOf(token), JSON.stringify(view), STUDY_TTL);
      return true;
    });
    if (typeof r === "object") return r;
    return { ok: true, token, expiresAt };
  }

  async get(token: string): Promise<{ ok: true; view: StudyView } | StudyFail> {
    if (!TOKEN_RE.test(token)) return fail("not_found", NOT_FOUND);
    const stored = await this.guard(() => this.kv.get(keyOf(token)));
    if (stored !== null && typeof stored === "object") return stored;
    try {
      const view = typeof stored === "string" ? (JSON.parse(stored) as StudyView) : null;
      if (!view || !Array.isArray(view.words)) return fail("not_found", NOT_FOUND);
      // Re-project on the way out: whatever is stored, only study fields can leave.
      return { ok: true, view: { title: String(view.title), expiresAt: view.expiresAt, words: view.words.map((w) => toStudyWord({ ...w, ja: w.ja })) } };
    } catch {
      return fail("not_found", NOT_FOUND);
    }
  }

  /** Teacher takes a page down. Idempotent: an unknown or already removed link is simply gone. */
  async unshare(token: string): Promise<{ ok: true } | StudyFail> {
    if (!TOKEN_RE.test(token)) return { ok: true };
    const r = await this.guard(async () => {
      await this.kv.set(keyOf(token), "gone", 1); // the store has no delete: overwrite with a marker that expires at once and never parses
      return true;
    });
    return typeof r === "object" ? r : { ok: true };
  }
}

const G = globalThis as unknown as { __vqsStudyService?: StudyService };
export function getStudyService(): StudyService {
  return (G.__vqsStudyService ??= new StudyService(() => kvFromEnv()));
}

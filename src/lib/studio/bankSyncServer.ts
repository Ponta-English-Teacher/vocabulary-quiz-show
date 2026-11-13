import { parseCqsExport } from "./cqsImport";

/**
 * Server side of "Sync Latest Bank": ask Classroom Quiz Show for its approved question bank.
 *
 * The token (CQS_SYNC_TOKEN) lives only in this server's environment. The address comes from the environment too (never from a request),
 * must be https (plain http only for localhost), redirects are never followed (the token must not travel anywhere else), the
 * request times out, and the answer is size-limited. Errors returned to the browser never contain the token or internal details.
 */
export const DEFAULT_CQS_URL = "https://classroom-quiz-show.vercel.app";
export const SYNC_PATH = "/api/sync/bank";
export const SYNC_TIMEOUT_MS = 10_000;
export const SYNC_MAX_BYTES = 3_000_000;
export const MIN_TOKEN_LENGTH = 32;
const ETAG = /^"cqs-[0-9a-f]{24}"$/;
/** Compression by the host turns a strong tag into a weak one (W/"…"). Both mean the same content here, so the tag is stored in its strong form. */
const normalizeEtag = (t: string | null): string | undefined => {
  const strong = t?.trim().replace(/^W\//, "");
  return strong && ETAG.test(strong) ? strong : undefined;
};

export type SyncConfig = { ok: true; url: string; token: string } | { ok: false; message: string };

export function syncConfig(env: Record<string, string | undefined> = process.env): SyncConfig {
  const token = env.CQS_SYNC_TOKEN;
  if (!token || token.length < MIN_TOKEN_LENGTH) return { ok: false, message: "Sync is not set up on this server yet (the Classroom Quiz Show sync token is missing)." };
  let base: URL;
  try {
    base = new URL(env.CQS_BASE_URL || DEFAULT_CQS_URL);
  } catch {
    return { ok: false, message: "Sync is not set up correctly on this server (the Classroom Quiz Show address is invalid)." };
  }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.username || base.password || (base.protocol !== "https:" && !(local && base.protocol === "http:"))) {
    return { ok: false, message: "Sync is not set up correctly on this server (the Classroom Quiz Show address must be https)." };
  }
  return { ok: true, url: `${base.origin}${SYNC_PATH}`, token };
}

export type SyncFetch =
  | { kind: "unchanged" }
  | { kind: "ok"; text: string; etag?: string }
  | { kind: "error"; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): SyncFetch => ({ kind: "error", status, code, message });

/** Read a response body but give up beyond `max` bytes. */
async function readLimited(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return (await res.text()).length > max ? null : await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchLatestBank(
  cfg: { url: string; token: string },
  etag: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = SYNC_TIMEOUT_MS,
): Promise<SyncFetch> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(cfg.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json", ...(etag && ETAG.test(etag) ? { "If-None-Match": etag } : {}) },
      cache: "no-store",
      redirect: "error",
      signal: ctl.signal,
    });
    if (res.status === 304) return { kind: "unchanged" };
    if (res.status === 401 || res.status === 403) return fail(502, "sync_rejected", "Classroom Quiz Show did not accept this server's sync token. Check the token on both sides.");
    if (res.status === 429) return fail(429, "sync_busy", "Classroom Quiz Show says too many requests. Wait a minute and try again.");
    if (res.status === 503) return fail(502, "sync_off", "Classroom Quiz Show has not turned on bank sync yet.");
    if (!res.ok) return fail(502, "sync_failed", `Classroom Quiz Show could not send the bank (status ${res.status}).`);
    const text = await readLimited(res, SYNC_MAX_BYTES);
    if (text === null) return fail(502, "sync_too_large", "The question bank from Classroom Quiz Show is larger than allowed, so it was not used.");
    const parsed = parseCqsExport(text);
    if (!parsed.ok) return fail(502, "sync_bad_data", `The answer from Classroom Quiz Show was not a question bank: ${parsed.error}`);
    const tag = normalizeEtag(res.headers.get("etag"));
    return { kind: "ok", text, ...(tag ? { etag: tag } : {}) };
  } catch (e) {
    if (ctl.signal.aborted) return fail(504, "sync_timeout", "Classroom Quiz Show did not answer in time. Try again in a moment.");
    const redirected = e instanceof Error && /redirect/i.test(e.message);
    return fail(502, redirected ? "sync_redirect" : "sync_unreachable", redirected ? "Classroom Quiz Show tried to redirect the request, which is not allowed." : "Could not reach Classroom Quiz Show.");
  } finally {
    clearTimeout(timer);
  }
}

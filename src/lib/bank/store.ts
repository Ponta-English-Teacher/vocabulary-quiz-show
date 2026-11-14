import { KvConfigError, KvError, type FetchLike, type KvEnv } from "@/lib/class/kv";

/**
 * Storage for the independent VQS word bank, on the SAME Upstash Redis as classroom play but in a completely separate namespace.
 *
 * Classroom play uses keys that start with "vqs:" (rooms, activities, teacher-auth counters…). The bank uses ONLY the three keys below,
 * all starting with "vqsbank:v1:". The store refuses any other key, so a bug can never read or write classroom data from here.
 * Bank data never expires (no TTL).
 *
 *   words    hash   word id → JSON of a BankWord
 *   ident    hash   sha256(identity of a live word: word + level + hints) → word id.  HSETNX on it is what makes concurrent or retried
 *                   imports unable to create the same record twice.
 *   imports  hash   import id (sha256 of the file text and choices) → JSON summary of that import, so a retry can be recognised
 */
export const NAMESPACE = "vqsbank:v1:";
export const KEYS = { words: `${NAMESPACE}words`, ident: `${NAMESPACE}ident`, imports: `${NAMESPACE}imports` } as const;
export type BankKey = (typeof KEYS)[keyof typeof KEYS];
const ALLOWED = new Set<string>(Object.values(KEYS));

export function assertBankKey(key: string): asserts key is BankKey {
  if (!ALLOWED.has(key)) throw new KvError("Refused: not a word-bank key.");
}

/** The only operations the bank needs. Each is atomic on its own field. */
export interface BankStore {
  hgetall(key: BankKey): Promise<Record<string, string>>;
  hget(key: BankKey, field: string): Promise<string | null>;
  hset(key: BankKey, field: string, value: string): Promise<void>;
  /** Set only if the field does not exist. Returns true when it was set. */
  hsetnx(key: BankKey, field: string, value: string): Promise<boolean>;
  hdel(key: BankKey, field: string): Promise<void>;
}

/** In-memory store for tests and for running locally without Redis. `log` records every command (name + key) for isolation checks. */
export class MemoryBankStore implements BankStore {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly log: { cmd: string; key: string }[] = [];
  private h(cmd: string, key: string) {
    assertBankKey(key);
    this.log.push({ cmd, key });
    let m = this.hashes.get(key);
    if (!m) this.hashes.set(key, (m = new Map()));
    return m;
  }
  async hgetall(key: BankKey) { return Object.fromEntries(this.h("HGETALL", key)); }
  async hget(key: BankKey, field: string) { return this.h("HGET", key).get(field) ?? null; }
  async hset(key: BankKey, field: string, value: string) { this.h("HSET", key).set(field, value); }
  async hsetnx(key: BankKey, field: string, value: string) {
    const m = this.h("HSETNX", key);
    if (m.has(field)) return false;
    m.set(field, value);
    return true;
  }
  async hdel(key: BankKey, field: string) { this.h("HDEL", key).delete(field); }
}

/** Upstash Redis over REST. Credentials stay inside this object: they are never put in an error message, log or response. */
export class UpstashBankStore implements BankStore {
  constructor(private url: string, private token: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i), private timeoutMs = 8000) {}

  private async cmd(command: (string | number)[]): Promise<unknown> {
    assertBankKey(String(command[1]));
    let res: Response;
    try {
      res = await this.fetchImpl(this.url.replace(/\/$/, ""), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new KvError("Could not reach the storage service.");
    }
    if (!res.ok) throw new KvError(`Storage service returned HTTP ${res.status}.`);
    let body: { result?: unknown; error?: string };
    try {
      body = (await res.json()) as { result?: unknown; error?: string };
    } catch {
      throw new KvError("Storage service sent an unreadable response.");
    }
    if (body && typeof body === "object" && body.error) throw new KvError("Storage command failed.");
    return body?.result ?? null;
  }

  async hgetall(key: BankKey) {
    const r = await this.cmd(["HGETALL", key]);
    const out: Record<string, string> = {};
    if (Array.isArray(r)) for (let i = 0; i + 1 < r.length; i += 2) out[String(r[i])] = String(r[i + 1]);
    else if (r && typeof r === "object") for (const [k, v] of Object.entries(r)) out[k] = String(v);
    return out;
  }
  async hget(key: BankKey, field: string) {
    const r = await this.cmd(["HGET", key, field]);
    return typeof r === "string" ? r : null;
  }
  async hset(key: BankKey, field: string, value: string) { await this.cmd(["HSET", key, field, value]); }
  async hsetnx(key: BankKey, field: string, value: string) { return Number(await this.cmd(["HSETNX", key, field, value])) === 1; }
  async hdel(key: BankKey, field: string) { await this.cmd(["HDEL", key, field]); }
}

/** Upstash (either env naming) → in-memory on a laptop → a loud error on Vercel. Same rule as classroom storage. */
export function bankStoreFromEnv(env: KvEnv = process.env as KvEnv, fetchImpl?: FetchLike): BankStore {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashBankStore(url, token, fetchImpl);
  if (env.VERCEL) throw new KvConfigError("Word-bank storage is not configured.");
  const g = globalThis as unknown as { __vqsBankMemory?: MemoryBankStore };
  return (g.__vqsBankMemory ??= new MemoryBankStore());
}

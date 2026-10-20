/**
 * Shared key-value storage for classroom state.
 *
 * On Vercel, requests run in different serverless instances that do NOT share memory, so rooms live in
 * Upstash Redis (reached over its REST API with plain fetch — no SDK, no extra dependency).
 * Locally (`next start` on a laptop) an in-memory store with the same interface is used.
 *
 * Rooms are stored as "<version>|<json>". `cas` is an atomic compare-and-set on that version, so two
 * simultaneous requests can never overwrite each other: the loser re-reads and re-applies.
 */

export type KvOp =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string; ttl: number }
  | { op: "exists"; key: string };

/** get → string|null, set → null, exists → 0|1 */
export type KvResult = string | null | number;

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Write only if the stored version equals `expectedVersion` (0 = the key must not exist). */
  cas(key: string, expectedVersion: number, value: string, ttlSeconds: number): Promise<boolean>;
  /** Several independent commands in ONE round trip (not atomic). */
  pipeline(ops: KvOp[]): Promise<KvResult[]>;
  /** Increment a counter, (re)setting its expiry. Returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export class KvError extends Error {}
export class KvConfigError extends KvError {}

/** "<version>|<json>" → version (0 if absent/malformed). */
export function versionOf(stored: string | null): number {
  if (!stored) return 0;
  const i = stored.indexOf("|");
  const v = i > 0 ? Number(stored.slice(0, i)) : NaN;
  return Number.isInteger(v) ? v : 0;
}

// ---- in-memory implementation (tests, local single-process use) --------------------------------------

export class MemoryKV implements KV {
  private data = new Map<string, { value: string; expires: number }>();
  constructor(private now: () => number = Date.now) {}

  private read(key: string): string | null {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expires <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return e.value;
  }
  private write(key: string, value: string, ttl: number) {
    this.data.set(key, { value, expires: this.now() + ttl * 1000 });
  }

  async get(key: string) {
    return this.read(key);
  }
  async set(key: string, value: string, ttl: number) {
    this.write(key, value, ttl);
  }
  async cas(key: string, expectedVersion: number, value: string, ttl: number) {
    const cur = this.read(key);
    if (cur === null ? expectedVersion !== 0 : versionOf(cur) !== expectedVersion) return false;
    this.write(key, value, ttl);
    return true;
  }
  async pipeline(ops: KvOp[]) {
    return ops.map((o): KvResult => {
      if (o.op === "get") return this.read(o.key);
      if (o.op === "set") return (this.write(o.key, o.value, o.ttl), null);
      return this.read(o.key) === null ? 0 : 1;
    });
  }
  async incr(key: string, ttl: number) {
    const n = (Number(this.read(key)) || 0) + 1;
    this.write(key, String(n), ttl);
    return n;
  }
}

// ---- Upstash Redis over REST --------------------------------------------------------------------------

const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[1])
if cur == false then
  if expected ~= 0 then return 0 end
else
  local v = tonumber(string.match(cur, '^(%d+)|'))
  if v ~= expected then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class UpstashKV implements KV {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private timeoutMs = 8000,
  ) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new KvError("Could not reach the storage service.");
    }
    // Never include the response body or the token in errors/logs.
    if (!res.ok) throw new KvError(`Storage service returned HTTP ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new KvError("Storage service sent an unreadable response.");
    }
  }

  private async one(command: (string | number)[]): Promise<unknown> {
    const r = (await this.call("", command)) as { result?: unknown; error?: string };
    if (r && typeof r === "object" && "error" in r && r.error) throw new KvError("Storage command failed.");
    return r?.result ?? null;
  }

  async get(key: string) {
    const r = await this.one(["GET", key]);
    return typeof r === "string" ? r : null;
  }
  async set(key: string, value: string, ttl: number) {
    await this.one(["SET", key, value, "EX", ttl]);
  }
  async cas(key: string, expectedVersion: number, value: string, ttl: number) {
    const r = await this.one(["EVAL", CAS_SCRIPT, 1, key, expectedVersion, value, ttl]);
    return Number(r) === 1;
  }
  async pipeline(ops: KvOp[]) {
    const cmds = ops.map((o) =>
      o.op === "get" ? ["GET", o.key] : o.op === "set" ? ["SET", o.key, o.value, "EX", o.ttl] : ["EXISTS", o.key],
    );
    const out = (await this.call("/pipeline", cmds)) as { result?: unknown; error?: string }[];
    if (!Array.isArray(out) || out.length !== ops.length) throw new KvError("Storage pipeline reply was malformed.");
    return out.map((r, i): KvResult => {
      if (r?.error) throw new KvError("Storage command failed.");
      const v = r?.result;
      if (ops[i].op === "get") return typeof v === "string" ? v : null;
      if (ops[i].op === "exists") return Number(v) ? 1 : 0;
      return null;
    });
  }
  async incr(key: string, ttl: number) {
    const out = (await this.call("/pipeline", [["INCR", key], ["EXPIRE", key, ttl]])) as { result?: unknown; error?: string }[];
    if (!Array.isArray(out) || out[0]?.error) throw new KvError("Storage command failed.");
    return Number(out[0]?.result) || 0;
  }
}

// ---- choosing the storage for this process ---------------------------------------------------------

export interface KvEnv {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  VERCEL?: string;
}

/** Upstash (either env-var naming the Vercel integration may use) → in-memory on a laptop → a loud error on Vercel. */
export function kvFromEnv(env: KvEnv = process.env as KvEnv, fetchImpl?: FetchLike): KV {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashKV(url, token, fetchImpl);
  if (env.VERCEL) {
    // Serverless instances don't share memory: silently using the in-memory store would split every group.
    throw new KvConfigError("Classroom storage is not configured (missing Upstash Redis environment variables).");
  }
  const g = globalThis as unknown as { __vqsMemoryKv?: MemoryKV };
  return (g.__vqsMemoryKv ??= new MemoryKV());
}

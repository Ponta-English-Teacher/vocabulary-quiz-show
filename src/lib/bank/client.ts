import type { ImportAnalysis } from "./import";
import type { BankIssue, BankStatus, BankWord } from "./types";

/**
 * Browser side of the word bank API: one small function per operation. The fetch function and the teacher header are injected so tests can
 * use a mock (nothing here talks to a real server unless the page runs it). The passcode is only ever sent as a request header.
 */
export interface ApiDeps {
  fetchImpl?: typeof fetch;
  headers?: () => Record<string, string>;
  /** Called on a 401 so the page can forget a wrong passcode and ask again. */
  onUnauthorized?: () => void;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string; issues?: BankIssue[] };

export interface Counts { draft: number; approved: number; archived: number; total: number }
export interface ListData { words: BankWord[]; counts: Counts; unreadable: number }
export interface ImportOutcome {
  importId: string; replayed: boolean; created: number; createdIds: string[]; total: number;
  skipped: { duplicate: number; invalid: number; heldForReview: number; alreadyAdded: number };
}

async function call<T>(deps: ApiDeps, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const f = deps.fetchImpl ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
  let res: Response;
  try {
    res = await f(`/api/wordbank${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(deps.headers?.() ?? {}) },
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, status: 0, code: "network", message: "Could not reach the server. Check your connection; nothing was changed that you can rely on." };
  }
  let j: { ok?: boolean; error?: { code?: string; message?: string; issues?: BankIssue[] } } & Record<string, unknown>;
  try {
    j = (await res.json()) as typeof j;
  } catch {
    return { ok: false, status: res.status, code: "bad_response", message: "The server sent an unreadable reply." };
  }
  if (res.status === 401) deps.onUnauthorized?.();
  if (!res.ok || j.ok === false) {
    return { ok: false, status: res.status, code: j.error?.code ?? "error", message: j.error?.message ?? "The request failed.", ...(j.error?.issues ? { issues: j.error.issues } : {}) };
  }
  return { ok: true, data: j as unknown as T };
}

export const makeApi = (deps: ApiDeps = {}) => ({
  list: (f: { status?: BankStatus } = {}) => call<ListData>(deps, "GET", f.status ? `?status=${encodeURIComponent(f.status)}` : ""),
  preview: (text: string, filename?: string) => call<ImportAnalysis & { dryRun: true; format: string }>(deps, "POST", "/import", { text, filename, dryRun: true }),
  importDrafts: (text: string, filename?: string, keep: number[] = []) => call<ImportOutcome>(deps, "POST", "/import", { text, filename, keep }),
  create: (word: unknown) => call<{ word: BankWord; issues: BankIssue[] }>(deps, "POST", "", { word }),
  edit: (id: string, patch: unknown) => call<{ word: BankWord; issues: BankIssue[] }>(deps, "PATCH", `/${encodeURIComponent(id)}`, { patch }),
  approve: (id: string) => call<{ word: BankWord }>(deps, "POST", `/${encodeURIComponent(id)}/approve`, {}),
  approveMany: (ids: string[]) => call<{ approved: string[]; failed: { id: string; message: string }[] }>(deps, "POST", "/approve-many", { ids }),
  archiveDrafts: (ids: string[]) => call<{ archived: string[] }>(deps, "POST", "/archive-drafts", { ids }),
  archive: (id: string) => call<{ word: BankWord }>(deps, "POST", `/${encodeURIComponent(id)}/archive`, {}),
  restore: (id: string) => call<{ word: BankWord }>(deps, "POST", `/${encodeURIComponent(id)}/restore`, {}),
  /** The whole bank as JSON text (for a file download). */
  exportAll: async (): Promise<ApiResult<{ text: string; filename: string }>> => {
    const f = deps.fetchImpl ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
    let res: Response;
    try {
      res = await f("/api/wordbank/export", { method: "GET", headers: deps.headers?.() ?? {}, cache: "no-store" });
    } catch {
      return { ok: false, status: 0, code: "network", message: "Could not reach the server." };
    }
    if (res.status === 401) deps.onUnauthorized?.();
    const text = await res.text();
    if (!res.ok) {
      let message = "The export failed.";
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* keep default */ }
      return { ok: false, status: res.status, code: "export_failed", message };
    }
    const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
    return { ok: true, data: { text, filename: m?.[1] ?? "vqs-wordbank.json" } };
  },
});
export type WordbankApi = ReturnType<typeof makeApi>;

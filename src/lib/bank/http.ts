import { checkTeacher, clientIdOf, TEACHER_HEADER, type TeacherEnv } from "@/lib/teacher/auth";
import type { KV } from "@/lib/class/kv";
import { BankService, type ServiceError } from "./service";
import type { BankStore } from "./store";
import { BANK_STATUSES, type BankStatus } from "./types";

/**
 * HTTP handler for the word bank: /api/wordbank/…  Every request needs the teacher passcode (the existing teacher authentication).
 * Authentication is checked FIRST, before the bank storage is even opened. Responses never contain the passcode or storage credentials.
 *
 *   GET    /api/wordbank?status=&cefr=&category=&q=   list words
 *   GET    /api/wordbank/export                       the complete bank as a JSON file
 *   POST   /api/wordbank/import   {text, filename?, dryRun?, keep?}   preview (dryRun) or import as drafts
 *   PATCH  /api/wordbank/<id>     {patch}             edit (returns the word to draft)
 *   POST   /api/wordbank/<id>/approve | archive | restore
 *   POST   /api/wordbank/approve-many   {ids}
 */
export interface WordbankDeps {
  env: TeacherEnv;
  /** Storage for the teacher-login failure counter only (the existing mechanism). */
  authKv: () => KV;
  /** The word-bank storage. Opened lazily, after authentication. */
  store: () => BankStore;
  now?: () => string;
  makeId?: () => string;
}

const HEADERS = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json({ ok: false, error: { code, message, ...extra } }, status);
const SERVICE_STATUS: Record<ServiceError["code"], number> = { not_found: 404, bad_request: 400, conflict: 409, invalid: 422 };
const fromService = (r: ServiceError) => err(SERVICE_STATUS[r.code], r.code, r.message, r.issues ? { issues: r.issues } : {});
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 6_100_000;

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleWordbank(request: Request, path: string[], deps: WordbankDeps): Promise<Response> {
  // 1. Authentication first. Nothing below runs, and no storage is opened, without it.
  const auth = await checkTeacher(request.headers.get(TEACHER_HEADER), deps.env, deps.authKv, clientIdOf(request));
  if (!auth.ok) return err(auth.status, auth.code, auth.message);

  let service: BankService;
  try {
    service = new BankService(deps.store(), deps.now, deps.makeId);
  } catch {
    return err(503, "unavailable", "The word bank storage is not available.");
  }

  try {
    return await route(request, path, service);
  } catch {
    // Storage failures: a fixed message only (never the underlying error, which could mention the service).
    return err(503, "unavailable", "The word bank storage did not respond. Nothing was changed that you can rely on; check the bank and try again.");
  }
}

async function route(request: Request, path: string[], service: BankService): Promise<Response> {
  const method = request.method.toUpperCase();
  const [a, b] = path;

  if (path.length === 0 && method === "GET") {
    const q = new URL(request.url).searchParams;
    const status = q.get("status");
    if (status && !(BANK_STATUSES as readonly string[]).includes(status)) return err(400, "bad_request", "Unknown status.");
    const r = await service.list({ status: (status as BankStatus) || undefined, cefr: q.get("cefr") || undefined, category: q.get("category") || undefined, q: q.get("q") || undefined });
    return json({ ok: true, ...r });
  }
  if (a === "export" && path.length === 1 && method === "GET") {
    const file = await service.exportAll();
    return json(file, 200, { "Content-Disposition": `attachment; filename="vqs-wordbank-${file.exportedAt.slice(0, 10)}.json"` });
  }
  if (a === "import" && path.length === 1 && method === "POST") {
    const b = await body(request);
    if (!b || typeof b.text !== "string") return err(400, "bad_request", "Send the file text as { text }.");
    const filename = typeof b.filename === "string" ? b.filename.slice(0, 200) : undefined;
    const keep = Array.isArray(b.keep) ? b.keep.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 2000) : [];
    if (b.dryRun === true) {
      const { analysis, format } = await service.previewImport(b.text, filename);
      return json({ ok: true, dryRun: true, format, ...analysis });
    }
    const r = await service.importDrafts(b.text, filename, keep);
    return "ok" in r ? fromService(r) : json({ ok: true, ...r });
  }
  if (a === "approve-many" && path.length === 1 && method === "POST") {
    const b = await body(request);
    if (!b) return err(400, "bad_request", "Invalid request.");
    const r = await service.approveMany(b.ids);
    return r.ok ? json(r) : fromService(r);
  }
  if (a && ID.test(a) && a !== "import" && a !== "export" && a !== "approve-many") {
    if (path.length === 1 && method === "PATCH") {
      const b = await body(request);
      if (!b) return err(400, "bad_request", "Invalid request.");
      const r = await service.edit(a, b.patch);
      return r.ok ? json(r) : fromService(r);
    }
    if (path.length === 2 && method === "POST" && (b === "approve" || b === "archive" || b === "restore")) {
      const r = await service[b](a);
      return r.ok ? json(r) : fromService(r);
    }
  }
  return err(404, "not_found", "Not found.");
}

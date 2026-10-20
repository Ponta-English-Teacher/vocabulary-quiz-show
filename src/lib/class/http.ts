import { networkInterfaces } from "node:os";
import type { ErrorCode } from "./types";

const STATUS: Record<ErrorCode, number> = {
  no_activity: 404, no_room: 404, bad_group: 400, bad_name: 400, bad_request: 400,
  full: 409, unauthorized: 401, forbidden: 403, bad_action: 400, busy: 503, unavailable: 503,
};

export const errorResponse = (code: ErrorCode, message: string) =>
  Response.json({ ok: false, error: { code, message } }, { status: STATUS[code], headers: { "Cache-Control": "no-store" } });

export const okResponse = (body: Record<string, unknown>) =>
  Response.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });

/** Session tokens travel in a header, never in a URL. */
export function bearer(request: Request): string {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export async function readJson(request: Request, maxChars = 100_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxChars) throw new Error("too large");
  return JSON.parse(text);
}

/** Phones need the laptop's Wi-Fi address, not "localhost". Never meaningful (or safe to show) on Vercel. */
export function lanAddresses(): string[] {
  if (process.env.VERCEL) return [];
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

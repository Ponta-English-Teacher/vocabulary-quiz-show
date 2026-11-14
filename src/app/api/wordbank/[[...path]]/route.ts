import { kvFromEnv } from "@/lib/class/kv";
import { bankStoreFromEnv } from "@/lib/bank/store";
import { handleWordbank, type WordbankDeps } from "@/lib/bank/http";
import type { TeacherEnv } from "@/lib/teacher/auth";

export const dynamic = "force-dynamic";

/** Teacher-only word bank API (independent bank, Phase 2). Not used by gameplay, and no teacher screen calls it yet. */
const deps = (): WordbankDeps => ({
  env: process.env as TeacherEnv,
  authKv: () => kvFromEnv(process.env as never),
  store: () => bankStoreFromEnv(process.env as never),
});

type Ctx = { params: Promise<{ path?: string[] }> };
const run = async (request: Request, ctx: Ctx) => handleWordbank(request, (await ctx.params).path ?? [], deps());

export const GET = run;
export const POST = run;
export const PATCH = run;

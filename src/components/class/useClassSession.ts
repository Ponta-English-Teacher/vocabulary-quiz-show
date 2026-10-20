"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClassView, ClientAction } from "@/lib/class/types";

type Status = "loading" | "invalid" | "join" | "active";
export type Connection = "online" | "reconnecting";

interface Stored {
  group: string;
  token: string;
}

const storageKey = (activityId: string) => `vqs.class.${activityId}`;
const POLL_MS = 1200;
const POLL_HIDDEN_MS = 3000;

function readStored(activityId: string): Stored | null {
  try {
    const raw = localStorage.getItem(storageKey(activityId));
    const j = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    return j && typeof j.group === "string" && typeof j.token === "string" ? { group: j.group, token: j.token } : null;
  } catch {
    return null;
  }
}
function writeStored(activityId: string, v: Stored | null) {
  try {
    if (v) localStorage.setItem(storageKey(activityId), JSON.stringify(v));
    else localStorage.removeItem(storageKey(activityId));
  } catch {
    /* storage blocked: the session simply won't survive a refresh */
  }
}

// crypto.randomUUID needs HTTPS; classroom LAN testing is plain http, so don't rely on it.
const newOpId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 6000);
  try {
    const res = await fetch(url, { ...init, cache: "no-store", signal: ctl.signal });
    const body = await res.json().catch(() => null);
    return { network: false as const, status: res.status, body };
  } catch {
    return { network: true as const, status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

/**
 * One student's connection to their group. The server is the single source of truth:
 * this hook only joins, polls for this player's own view, and sends actions.
 * The role is whatever the server's view says — it is never chosen or stored here.
 */
export function useClassSession(activityId: string) {
  const [status, setStatus] = useState<Status>("loading");
  const [title, setTitle] = useState("");
  const [view, setView] = useState<ClassView | null>(null);
  const [connection, setConnection] = useState<Connection>("online");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useRef<Stored | null>(null);
  const versionRef = useRef(0);

  const apply = useCallback((v: ClassView) => {
    if (v.version >= versionRef.current) {
      versionRef.current = v.version;
      setView(v);
    }
  }, []);

  const endSession = useCallback(
    (message: string | null) => {
      session.current = null;
      versionRef.current = 0;
      writeStored(activityId, null);
      setView(null);
      setError(message);
      setStatus("join");
    },
    [activityId],
  );

  const doJoin = useCallback(
    async (name: string, group: string, token?: string) => {
      const r = await request(`/api/class/${activityId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, group, token }),
      });
      if (r.network) return { ok: false as const, network: true, message: "Can't reach the server. Check your Wi-Fi and try again." };
      if (!r.body?.ok) return { ok: false as const, network: false, code: r.body?.error?.code as string | undefined, message: (r.body?.error?.message as string) ?? "Could not join." };
      session.current = { group: r.body.view.group, token: r.body.token };
      writeStored(activityId, session.current);
      versionRef.current = 0;
      apply(r.body.view as ClassView);
      setConnection("online");
      return { ok: true as const };
    },
    [activityId, apply],
  );

  // Initial load: validate the link, then silently recover a previous session if this phone has one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await request(`/api/class/${activityId}`);
      if (cancelled) return;
      if (info.network) {
        setError("Can't reach the server. Check your Wi-Fi, then reload.");
        setStatus("invalid");
        return;
      }
      if (!info.body?.ok) {
        setStatus("invalid");
        return;
      }
      setTitle(info.body.title);
      const stored = readStored(activityId);
      if (stored) {
        const r = await doJoin("", stored.group, stored.token);
        if (cancelled) return;
        if (r.ok) return setStatus("active");
        if (r.network) {
          // Keep the session; show the screen as reconnecting until the poll succeeds.
          session.current = stored;
          setConnection("reconnecting");
          return setStatus("active");
        }
        if (r.code === "no_activity") return setStatus("invalid");
        endSession("Your earlier session has ended. Please join again.");
        return;
      }
      setStatus("join");
    })();
    return () => {
      cancelled = true;
    };
  }, [activityId, doJoin, endSession]);

  // Poll for this player's own view (also serves as the "I'm still here" heartbeat).
  useEffect(() => {
    if (status !== "active") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = session.current;
      if (!s || stop) return;
      const r = await request(`/api/class/${activityId}/state?group=${encodeURIComponent(s.group)}&since=${versionRef.current}`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      if (stop) return;
      if (r.network || r.status >= 500) {
        setConnection("reconnecting");
      } else if (r.status === 401) {
        return endSession("Your session has ended. Please join again.");
      } else if (r.body?.ok) {
        setConnection("online");
        if (r.body.view) apply(r.body.view as ClassView);
      }
      timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    };
    const wake = () => {
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [status, activityId, apply, endSession]);

  const join = useCallback(
    async (name: string, group: string) => {
      setBusy(true);
      setError(null);
      const r = await doJoin(name, group);
      setBusy(false);
      if (r.ok) setStatus("active");
      else setError(r.message);
    },
    [doJoin],
  );

  const act = useCallback(
    async (action: ClientAction) => {
      const s = session.current;
      if (!s) return;
      const opId = newOpId(); // same id on retry → the server applies it at most once
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await request(`/api/class/${activityId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ group: s.group, opId, action }),
        });
        if (r.network) {
          setConnection("reconnecting");
          continue;
        }
        setConnection("online");
        if (r.status === 401) return endSession("Your session has ended. Please join again.");
        if (!r.body?.ok) {
          setError(r.body?.error?.message ?? "That didn't work.");
          setTimeout(() => setError(null), 3500);
          return;
        }
        if (action.type === "LEAVE") return endSession(null);
        if (r.body.view) apply(r.body.view as ClassView);
        return;
      }
    },
    [activityId, apply, endSession],
  );

  return { status, title, view, connection, error, busy, join, act };
}

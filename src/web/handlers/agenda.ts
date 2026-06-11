import type http from "node:http";
import { listMeetings, listTodos, setTodoDone } from "../../db/repositories/agenda.js";
import { listPeople } from "../../db/repositories/people.js";
import { buildIcs } from "../../summarization/build-ics.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** GET /api/people — the derived People list. */
export async function handlePeople(
  _url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  try {
    const people = await listPeople(deps.pool);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(people.map((p) => ({ ...p, lastContactAt: iso(p.lastContactAt) }))));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load people." }));
  }
}

/** GET /api/meetings?from=&to= — the local agenda. */
export async function handleMeetings(
  url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const parseDate = (key: string): Date | undefined => {
    const raw = url.searchParams.get(key);
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  try {
    const meetings = await listMeetings(deps.pool, {
      from: parseDate("from"),
      to: parseDate("to"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(meetings.map((m) => ({ ...m, startsAt: iso(m.startsAt) }))));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load meetings." }));
  }
}

/**
 * GET /api/meetings.ics — the LOCAL agenda as a downloadable iCalendar file (S8).
 * The constitution-safe alternative to outbound calendar sync: the user imports
 * this into any calendar themselves; nothing leaves the box automatically.
 */
export async function handleMeetingsIcs(
  _url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  try {
    const meetings = await listMeetings(deps.pool);
    const ics = buildIcs(meetings, new Date());
    res.writeHead(200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="catchapp.ics"',
    });
    res.end(ics);
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to export calendar." }));
  }
}

/**
 * GET   /api/todos        — the checklist.
 * PATCH /api/todos/:id    — toggle done {done:boolean}. CSRF-guarded by dispatchApi.
 */
export async function handleTodos(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/todos") {
    try {
      const todos = await listTodos(deps.pool);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(todos.map((t) => ({ ...t, dueAt: iso(t.dueAt) }))));
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to load todos." }));
    }
    return;
  }
  if (req.method === "PATCH") {
    const m = /^\/api\/todos\/(\d+)$/.exec(url.pathname);
    if (m) {
      const body = await readJsonBody(req);
      if (typeof body?.done !== "boolean") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "done must be a boolean." }));
        return;
      }
      try {
        const ok = await setTodoDone(deps.pool, Number(m[1]), body.done as boolean);
        res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { ok: true } : { error: "Unknown todo." }));
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to update todo." }));
      }
      return;
    }
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found." }));
}

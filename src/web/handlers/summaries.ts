import type http from "node:http";
import { findGroupByName } from "../../db/repositories/groups.js";
import { listSummariesByGroup } from "../../db/repositories/summaries.js";
import { normalizeSummaryOutput } from "../../summarization/normalize.js";
import type { ServerDeps } from "./context.js";

export async function handleSummaries(
  url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const group = url.searchParams.get("group");
  if (!group) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing group." }));
    return;
  }
  // Parse and clamp limit
  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
  }
  try {
    const grp = await findGroupByName(deps.pool, group);
    if (!grp) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    const summaries = await listSummariesByGroup(deps.pool, grp.id, limit);
    const serialized = summaries.map((s) => ({
      id: s.id,
      summaryType: s.summaryType,
      parameters: s.parameters,
      // Normalize so the client always gets a consistent shape: structured rows
      // pass through; legacy prose rows are sectioned best-effort. `output.overview`
      // stays the full markdown, so existing readers are unaffected.
      output: normalizeSummaryOutput(s.output),
      model: s.model,
      createdAt: s.createdAt.toISOString(),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(serialized));
  } catch (err) {
    process.stderr.write(
      `Error handling /api/summaries: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error." }));
  }
}

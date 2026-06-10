import type http from "node:http";
import type { SessionHealth, TenantSessionStatus } from "../collector/tenant-session-registry.js";
import { sseFrame } from "./sse.js";

/**
 * T4 — web onboarding (register → verify → scan QR → "connected").
 *
 * The /api/onboarding/* surface is a thin adapter over the TenantSessionRegistry: it
 * starts the requesting tenant's session, streams that tenant's QR refreshes over SSE,
 * and reports link status. Everything is scoped to the AUTHENTICATED tenant the server
 * resolves — a tenant can only ever link/observe its own session.
 */

/** The slice of TenantSessionRegistry onboarding needs (the real registry satisfies it). */
export interface OnboardingRegistry {
  start(tenantId: string): Promise<void>;
  snapshot(): SessionHealth[];
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type OnboardingStatus = "unlinked" | "connecting" | "connected" | "logged-out" | "failed";

export type OnboardingRoutesOptions = { registry: OnboardingRegistry };

/** Collapse the registry's fine-grained session status into what the onboarding UI needs. */
function toOnboardingStatus(status: TenantSessionStatus | undefined): OnboardingStatus {
  switch (status) {
    case "connected":
      return "connected";
    case "logged-out":
      return "logged-out";
    case "failed":
      return "failed";
    case "connecting":
    case "disconnected":
      return "connecting";
    default:
      return "unlinked";
  }
}

export function makeOnboardingRoutes(opts: OnboardingRoutesOptions) {
  const { registry } = opts;

  const statusOf = (tenantId: string): OnboardingStatus => {
    const health = registry.snapshot().find((h) => h.tenantId === tenantId);
    return toOnboardingStatus(health?.status);
  };

  /**
   * Handle an /api/onboarding/* request for the already-authenticated `tenantId`.
   * Returns true when handled.
   */
  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    tenantId: string,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/api/onboarding/")) return false;

    if (req.method === "GET" && url.pathname === "/api/onboarding/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: statusOf(tenantId) }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/onboarding/link") {
      // Fire-and-forget: start() supervises its own retries; the QR arrives over SSE.
      void registry.start(tenantId).catch(() => {});
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "connecting" }));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/onboarding/qr") {
      streamQr(req, res, tenantId);
      return true;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
    return true;
  };

  const streamQr = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tenantId: string,
  ): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(sseFrame(event, data));

    const onQr = (...args: unknown[]): void => {
      if (args[0] !== tenantId) return;
      // Render server-side to a data URL so the browser just shows an <img> — no
      // client-side QR library (and no CSP exception) needed.
      void renderQrDataUrl(String(args[1]))
        .then((dataUrl) => send("qr", { dataUrl }))
        .catch(() => {});
    };
    const onConnected = (...args: unknown[]): void => {
      if (args[0] !== tenantId) return;
      send("connected", { tenantId });
      cleanup();
      res.end();
    };
    const onLoggedOut = (...args: unknown[]): void => {
      if (args[0] !== tenantId) return;
      send("logged-out", { tenantId });
      cleanup();
      res.end();
    };
    const cleanup = (): void => {
      registry.off("qr", onQr);
      registry.off("connected", onConnected);
      registry.off("logged-out", onLoggedOut);
    };

    registry.on("qr", onQr);
    registry.on("connected", onConnected);
    registry.on("logged-out", onLoggedOut);
    req.on("close", () => {
      cleanup();
    });

    // Opening the onboarding pane should produce a QR even on first visit, so kick the
    // session off if nothing is in flight yet. start() is idempotent while a session exists.
    const current = registry.snapshot().find((h) => h.tenantId === tenantId)?.status;
    if (current !== "connecting" && current !== "connected") {
      void registry.start(tenantId).catch(() => {});
    }
  };

  return { handle, statusOf };
}

/** Encode a WhatsApp linking string to a PNG data URL via the `qrcode` dep (CommonJS). */
async function renderQrDataUrl(qr: string): Promise<string> {
  type QrToDataURL = (text: string, opts?: Record<string, unknown>) => Promise<string>;
  const specifier = "qrcode" as string;
  const mod = (await import(specifier)) as {
    toDataURL?: QrToDataURL;
    default?: { toDataURL?: QrToDataURL };
  };
  const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
  if (!toDataURL) throw new Error("qrcode.toDataURL unavailable");
  return toDataURL(qr, { margin: 1, width: 264 });
}

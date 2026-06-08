/**
 * session.ts — Baileys WebSocket session management.
 *
 * Responsibilities:
 * - Load/persist auth state via useMultiFileAuthState under data/baileys-auth/
 * - Print a scannable QR on first link (via the `qrcode` library; raw string fallback)
 * - Auto-reconnect on dropped connection (unless logged out)
 * - Emit incoming group messages for the collector to process
 *
 * This module is intentionally thin and WhatsApp-specific so that everything
 * else (collector.ts, CLI) remains testable without a real socket.
 *
 * NOTE: T019 (live-account validation spike) is DEFERRED. This module is
 * implemented against the Baileys API as documented but has NOT been validated
 * against a real WhatsApp account in this task.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type Chat,
  type ConnectionState,
  type Contact,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { createHistorySyncProgress, type HistorySyncProgress } from "./history-sync-progress.js";
import { applyOutboundGuard } from "./outbound-guard.js";

export type SessionEvents = {
  message: [msg: WAMessage];
  qr: [qr: string];
  connected: [];
  disconnected: [];
  /** WhatsApp contacts directory (saved names + push names) for name resolution. */
  contacts: [contacts: Contact[]];
  /** Chat/group directory entries (with subjects) delivered on history sync. */
  chats: [chats: Chat[]];
};

/**
 * CollectorSession wraps a Baileys socket and provides a stable event interface.
 */
export class CollectorSession extends EventEmitter {
  private socket: WASocket | null = null;
  private authDir: string;
  private stopped = false;
  private storedMessages = 0;
  /** When false (default), the socket is hard-guarded to never send anything. */
  private allowSend: boolean;
  /** Collapses the per-batch history-sync flood into throttled progress + a summary. */
  private historyProgress: HistorySyncProgress;

  constructor(authDir: string, allowSend = false) {
    super();
    this.authDir = authDir;
    this.allowSend = allowSend;
    this.historyProgress = createHistorySyncProgress({
      log: (line) => process.stderr.write(`${line}\n`),
    });
  }

  /** Total messages reported as stored (updated by caller via incrementStored). */
  get storedCount(): number {
    return this.storedMessages;
  }

  incrementStored(): void {
    this.storedMessages++;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.socket?.end(undefined);
    } catch {
      // ignore
    }
    this.socket = null;
  }

  /**
   * Download the media payload (e.g. a voice note) for a received message as a
   * Buffer, via Baileys. Used by the collector to persist voice-note audio so
   * it can be transcribed. Throws if the socket is not connected.
   *
   * This is the WhatsApp-specific glue kept in the (thin, untested) session
   * module; the collector that calls it takes this as an injected function and
   * stays testable without a real socket.
   */
  async downloadMedia(msg: WAMessage): Promise<Buffer> {
    const sock = this.socket;
    if (!sock) {
      throw new Error("Cannot download media: socket not connected.");
    }
    const buf = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: makeSilentLogger() as never,
        reuploadRequest: sock.updateMediaMessage,
      },
    );
    return buf as Buffer;
  }

  /**
   * Fetch the subject (display name) of a WhatsApp group chat by JID.
   *
   * Thin session glue (untested, like downloadMedia): wraps
   * socket.groupMetadata(jid).subject. Throws if the socket is not connected.
   */
  async groupSubject(jid: string): Promise<string> {
    const sock = this.socket;
    if (!sock) {
      throw new Error("Cannot fetch group subject: socket not connected.");
    }
    const md = await sock.groupMetadata(jid);
    return md.subject ?? "";
  }

  /**
   * Request WhatsApp to send older history for a chat.
   *
   * T010 — thin session glue (untested, like downloadMedia).
   * Wraps socket.fetchMessageHistory; throws if the socket is not connected.
   *
   * @param count    Number of messages to request.
   * @param anchorKey  The message anchor (paginate before this message).
   * @param anchorTsMs The anchor message timestamp in milliseconds.
   * @returns A request id string.
   */
  async fetchMessageHistory(
    count: number,
    anchorKey: { remoteJid: string; id: string; fromMe: boolean },
    anchorTsMs: number,
  ): Promise<string> {
    const sock = this.socket;
    if (!sock) {
      throw new Error("Cannot fetch message history: socket not connected.");
    }
    return sock.fetchMessageHistory(
      count,
      { remoteJid: anchorKey.remoteJid, id: anchorKey.id, fromMe: anchorKey.fromMe },
      anchorTsMs,
    );
  }

  /**
   * Wait for Baileys to deliver a 'messaging-history.set' event for the given chat JID,
   * and resolve with the messages contained in that event.
   *
   * T010 — thin session glue (untested, like downloadMedia).
   * Registers a one-time listener; always cleans up (resolve or timeout).
   *
   * @param chatJid   The group/chat JID to filter events by.
   * @param timeoutMs Resolve with [] if no event arrives within this budget.
   * @returns Array of WAMessages from the history batch, or [] on timeout.
   */
  async awaitHistorySync(chatJid: string, timeoutMs: number): Promise<WAMessage[]> {
    const sock = this.socket;
    if (!sock) {
      return [];
    }

    return new Promise<WAMessage[]>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        sock.ev.off("messaging-history.set", handler);
      };

      const handler = (data: { messages: WAMessage[]; isLatest?: boolean }) => {
        if (settled) return;
        // Filter messages belonging to this chat
        const relevant = data.messages.filter((m) => m.key?.remoteJid === chatJid);
        if (relevant.length === 0) return; // Not for our chat — keep waiting
        settled = true;
        cleanup();
        resolve(relevant);
      };

      sock.ev.on("messaging-history.set", handler);

      timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve([]);
        },
        Math.max(0, timeoutMs),
      );
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    // Ensure auth directory exists
    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const sock = makeWASocket({
      auth: state,
      // Disable browser history fetch — forward-only (research R3)
      syncFullHistory: false,
      // Do NOT announce presence/online on connect — stay an invisible observer
      // (also avoids stealing notifications from the phone). Safety guardrail.
      markOnlineOnConnect: false,
      // Print connection logs to stderr to keep stdout clean for QR/heartbeat
      logger: makeSilentLogger(),
    });

    // SAFETY: unless sending is explicitly enabled, neutralize all outbound
    // methods so the linked device can never send messages, receipts, or
    // presence. Belt-and-suspenders on top of markOnlineOnConnect.
    applyOutboundGuard(sock, this.allowSend);

    this.socket = sock;

    // Persist credentials whenever they update (keeps session alive across restarts)
    sock.ev.on("creds.update", saveCreds);

    // Contacts directory — the only source for SAVED contact names / push names.
    // Forwarded for the collector to resolve 1:1 chat display names.
    sock.ev.on("contacts.upsert", (contacts: Contact[]) => {
      diagContacts("contacts.upsert", contacts);
      if (contacts.length > 0) this.emit("contacts", contacts);
    });
    sock.ev.on("contacts.update", (updates: Partial<Contact>[]) => {
      diagContacts("contacts.update", updates);
      const contacts = updates.filter((c): c is Contact => typeof c.id === "string");
      if (contacts.length > 0) this.emit("contacts", contacts);
    });

    // Handle connection state changes
    sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Emit QR for the CLI to print
        this.emit("qr", qr);
        printQr(qr);
      }

      if (connection === "open") {
        if (DIAG_NAMES) {
          process.stderr.write(
            "[diag-names] active — watching contacts.upsert/update + history.set (chats/contacts/lidPnMappings)\n",
          );
        }
        this.emit("connected");
      }

      if (connection === "close") {
        this.emit("disconnected");

        if (this.stopped) return;

        // Determine if we should reconnect
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.error("WhatsApp session logged out. Delete data/baileys-auth/ and re-link.");
        } else {
          // Reconnect after a brief delay
          setTimeout(() => {
            this.connect().catch((err: unknown) => {
              console.error("Reconnect failed:", err);
            });
          }, 3000);
        }
      }
    });

    // Forward incoming messages to listeners.
    // 'notify' = live messages; 'append' = messages WhatsApp queued while we were
    // offline, replayed on reconnect. Both are recovered — handleIncomingMessage
    // dedupes on dedupe_key, so replays/overlap are idempotent.
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;

      // Diagnostic: 'append' is the offline-replay channel — log how much arrives so
      // we can see whether WhatsApp actually delivers missed messages on reconnect.
      if (type === "append" && messages.length > 0) {
        process.stderr.write(`[history-sync] append: ${messages.length} message(s)\n`);
      }
      for (const msg of messages) {
        this.emit("message", msg);
      }
    });

    // On (re)connect WhatsApp pushes a bounded recent-history batch. Persist it so
    // messages missed during downtime are recovered. syncFullHistory stays false, so
    // this is the recent window only; dedup makes overlap with live/append idempotent.
    sock.ev.on(
      "messaging-history.set",
      ({
        messages,
        chats,
        contacts,
        lidPnMappings,
      }: {
        messages: WAMessage[];
        chats: Chat[];
        contacts: Contact[];
        lidPnMappings?: { pn: string; lid: string }[];
      }) => {
        diagHistory(chats, contacts, lidPnMappings);

        // The history payload also carries the chat + contact directory — the
        // only source for names of groups we can't fetch a subject for and for
        // saved 1:1 contact names. Forward both for resolution.
        if (chats?.length > 0) this.emit("chats", chats);
        if (contacts?.length > 0) this.emit("contacts", contacts);

        // Collapse the per-batch flood into a throttled progress line + summary
        // (instead of one log line per batch). The collector dedups the contents.
        this.historyProgress.record(messages.length);
        for (const msg of messages) {
          this.emit("message", msg);
        }
      },
    );
  }
}

/**
 * Start a CollectorSession and return it.
 */
export async function startSession(authDir: string, allowSend = false): Promise<CollectorSession> {
  const session = new CollectorSession(authDir, allowSend);
  await session.start();
  return session;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Print a scannable QR code to the terminal.
 *
 * Uses the `qrcode` library (handles WhatsApp's long linking payload, which
 * `qrcode-terminal` cannot — it throws "bad rs block" on long input). Dynamic
 * import via a string-typed specifier resolves from this module's node_modules
 * and avoids static type resolution (no @types needed). `qrcode` is CommonJS,
 * so `toString` may sit on the namespace or on `.default` — handle both.
 * Falls back to the raw linking string if rendering fails for any reason.
 */
function printQr(qr: string): void {
  type QrToString = (text: string, opts: { type: "terminal"; small: boolean }) => Promise<string>;
  const specifier = "qrcode" as string;
  import(specifier)
    .then(async (mod: unknown) => {
      const m = mod as { toString?: QrToString; default?: { toString?: QrToString } };
      const toStringFn = m.toString ?? m.default?.toString;
      if (typeof toStringFn !== "function") {
        throw new Error("qrcode: toString() not found");
      }
      console.log(await toStringFn(qr, { type: "terminal", small: true }));
    })
    .catch((err: unknown) => {
      if (process.env["QR_DEBUG"] === "1") {
        console.error("[printQr] qrcode render failed:", err);
      }
      console.log(`QR Code (scan with WhatsApp):\n${qr}`);
    });
}

// ---------------------------------------------------------------------------
// Name-resolution diagnostics (opt-in via CATCHUP_DIAG_NAMES=1)
// ---------------------------------------------------------------------------
// 1:1 (@s.whatsapp.net) chats weren't resolving while groups did. These gated
// probes report exactly what WhatsApp delivers — contact field coverage and the
// lid↔pn mapping — so we can see whether contacts arrive and how they're keyed
// before committing to a fix. No-ops unless the env flag is set.

const DIAG_NAMES = process.env.CATCHUP_DIAG_NAMES === "1";

function diagContacts(source: string, contacts: Partial<Contact>[]): void {
  if (!DIAG_NAMES || contacts.length === 0) return;
  const has = (pred: (c: Partial<Contact>) => unknown) => contacts.filter(pred).length;
  const summary =
    `[diag-names] ${source}: total=${contacts.length}` +
    ` name=${has((c) => c.name?.trim())}` +
    ` notify=${has((c) => c.notify?.trim())}` +
    ` verifiedName=${has((c) => c.verifiedName?.trim())}` +
    ` phoneNumber=${has((c) => c.phoneNumber)}` +
    ` id@s=${has((c) => c.id?.endsWith("@s.whatsapp.net"))}` +
    ` id@lid=${has((c) => c.id?.endsWith("@lid"))}`;
  process.stderr.write(`${summary}\n`);
  for (const c of contacts.slice(0, 3)) {
    process.stderr.write(
      `[diag-names]   sample id=${c.id} lid=${c.lid ?? "-"} phoneNumber=${c.phoneNumber ?? "-"} name=${c.name ?? "-"} notify=${c.notify ?? "-"}\n`,
    );
  }
}

function diagHistory(
  chats: Chat[] | undefined,
  contacts: Contact[] | undefined,
  lidPnMappings: { pn: string; lid: string }[] | undefined,
): void {
  if (!DIAG_NAMES) return;
  process.stderr.write(
    `[diag-names] history.set: chats=${chats?.length ?? 0} contacts=${contacts?.length ?? 0} lidPnMappings=${lidPnMappings?.length ?? 0}\n`,
  );
  for (const m of (lidPnMappings ?? []).slice(0, 3)) {
    process.stderr.write(`[diag-names]   lidPn pn=${m.pn} lid=${m.lid}\n`);
  }
}

/**
 * Create a minimal logger that suppresses all output (keeps stdout/stderr clean).
 * Baileys expects a pino-compatible logger.
 */
function makeSilentLogger() {
  const noop = () => {};
  return {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => makeSilentLogger(),
  };
}

// Re-export WAMessage for use by the CLI
export type { WAMessage };

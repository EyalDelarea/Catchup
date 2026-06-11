import type { Mailer } from "./service.js";

/**
 * Dev/self-host mailer: surfaces the email locally instead of sending it. Real SMTP
 * delivery is a deliberate deferral — the Mailer seam in AuthDeps is where it plugs in
 * later, and production should use it rather than this log mailer.
 *
 * The email BODY carries the raw verify/reset token. It is deliberately kept OUT of the
 * structured log (which may ship to a remote aggregator via LOKI_URL — a token leaving
 * the box would let anyone with log access verify/reset the account). The structured log
 * records only that an email was issued; the link is written straight to stdout (the
 * operator's local terminal, not forwarded to the structured/remote sink) so dev linking
 * still works.
 */
export function createLogMailer(
  log: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
  },
  // Local sink for the link. Defaults to stdout (the operator's terminal); injectable for
  // tests. Deliberately NOT the structured logger, so the token isn't shipped to LOKI_URL.
  writeLine: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
): Mailer {
  return {
    async send(to: string, subject: string, body: string): Promise<void> {
      log.info({ to, subject }, "auth email (log mailer)");
      writeLine(`\n[auth email] to=${to} subject=${subject}\n${body}\n\n`);
    },
  };
}

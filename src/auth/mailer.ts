import type { Mailer } from "./service.js";

/**
 * Dev/self-host mailer: writes the email to the structured log instead of sending it.
 * The operator reads verify/reset links from the logs. Real SMTP delivery is a
 * deliberate deferral — the Mailer seam in AuthDeps is where it plugs in later.
 */
export function createLogMailer(log: {
  info: (obj: Record<string, unknown>, msg?: string) => void;
}): Mailer {
  return {
    async send(to: string, subject: string, body: string): Promise<void> {
      log.info({ to, subject, body }, "auth email (log mailer)");
    },
  };
}

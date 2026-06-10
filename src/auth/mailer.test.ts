import { describe, expect, it } from "vitest";
import { createLogMailer } from "./mailer.js";

describe("createLogMailer", () => {
  it("logs the recipient, subject and body so the operator can read links from logs", async () => {
    const lines: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const mailer = createLogMailer({
      info: (obj: Record<string, unknown>, msg?: string) => {
        lines.push({ obj, msg });
      },
    });

    await mailer.send("a@b.test", "Verify", "click http://x/verify?token=abc");

    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ to: "a@b.test", subject: "Verify" });
    expect(String(lines[0]!.obj["body"])).toContain("token=abc");
  });
});

import { describe, expect, it } from "vitest";
import { createLogMailer } from "./mailer.js";

describe("createLogMailer", () => {
  it("keeps the token out of the structured log but surfaces the link locally", async () => {
    const lines: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const written: string[] = [];
    const mailer = createLogMailer(
      {
        info: (obj: Record<string, unknown>, msg?: string) => {
          lines.push({ obj, msg });
        },
      },
      (line) => written.push(line),
    );

    await mailer.send("a@b.test", "Verify", "click http://x/verify?token=abc");

    // Structured log: recipient + subject only, never the token-bearing body (it may ship
    // to a remote aggregator).
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ to: "a@b.test", subject: "Verify" });
    expect(JSON.stringify(lines[0]!.obj)).not.toContain("token=abc");

    // The operator still gets the link on the local sink.
    expect(written.join("")).toContain("token=abc");
  });
});

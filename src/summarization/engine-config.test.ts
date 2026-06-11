import { describe, expect, it } from "vitest";
import { enabledKinds, loadEngineConfig, proactivenessCap } from "./engine-config.js";

describe("loadEngineConfig", () => {
  it("defaults to off, all kinds on, balanced", () => {
    const c = loadEngineConfig(null);
    expect(c).toEqual({
      on: false,
      kinds: { task: true, meeting: true, followup: true, recap: true },
      proact: "מאוזן",
    });
  });

  it("reads the stored shape and ignores unknown fields", () => {
    const c = loadEngineConfig({ on: true, kinds: { task: false }, proact: "יוזם", extra: 1 });
    expect(c.on).toBe(true);
    expect(c.kinds.task).toBe(false);
    expect(c.kinds.meeting).toBe(true);
    expect(c.proact).toBe("יוזם");
  });

  it("falls back to balanced for an invalid proact", () => {
    expect(loadEngineConfig({ proact: "bogus" }).proact).toBe("מאוזן");
  });
});

describe("proactivenessCap", () => {
  it("maps levels to caps", () => {
    expect(proactivenessCap("עדין")).toBe(1);
    expect(proactivenessCap("מאוזן")).toBe(3);
    expect(proactivenessCap("יוזם")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("enabledKinds", () => {
  it("returns only enabled kinds in stable order", () => {
    const c = loadEngineConfig({ kinds: { task: true, meeting: false, followup: true, recap: false } });
    expect(enabledKinds(c)).toEqual(["task", "followup"]);
  });
});

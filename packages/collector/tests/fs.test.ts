import { describe, expect, it } from "vitest";
import { normalizeUrl, processHiddenSecretInput } from "../src/fs";

describe("collector hidden secret input", () => {
  it("accepts a pasted API key and submit without exposing it", () => {
    expect(processHiddenSecretInput("", "lm_live_example\r")).toEqual({
      value: "lm_live_example",
      submitted: true,
      cancelled: false,
    });
  });

  it("supports correcting pasted input with backspace", () => {
    expect(processHiddenSecretInput("wrong", "\b\b\b\b\blm_live_fixed")).toEqual({
      value: "lm_live_fixed",
      submitted: false,
      cancelled: false,
    });
  });

  it("recognizes cancellation", () => {
    expect(processHiddenSecretInput("partial", "\u0003")).toEqual({
      value: "partial",
      submitted: false,
      cancelled: true,
    });
  });

  it("uses the canonical host so authorization is not lost on redirect", () => {
    expect(normalizeUrl("https://runtraice.com/")).toBe("https://www.runtraice.com");
    expect(normalizeUrl("https://staging.runtraice.com/")).toBe("https://staging.runtraice.com");
  });
});

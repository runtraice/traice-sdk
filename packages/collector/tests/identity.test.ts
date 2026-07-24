import { describe, expect, it, vi } from "vitest";
import { confirmSetupPlan, resolveFirstRunSetupIdentity } from "../src/identity";

describe("collector first-run identity", () => {
  it("asks which email to use when the requested and Git emails differ", async () => {
    const prompt = vi.fn().mockResolvedValueOnce("2").mockResolvedValueOnce("");

    const result = await resolveFirstRunSetupIdentity(
      { employeeEmail: "workspace@example.com", teamName: "Engineering" },
      {
        interactive: true,
        gitEmail: () => "developer@example.com",
        prompt,
      },
    );

    expect(result).toEqual({ employeeEmail: "developer@example.com", teamName: "Engineering" });
    expect(prompt.mock.calls[0]?.[0]).toContain("workspace@example.com");
    expect(prompt.mock.calls[0]?.[0]).toContain("developer@example.com");
    expect(prompt.mock.calls[1]?.[0]).toContain("Engineering (default)");
    expect(prompt.mock.calls[1]?.[0]).toContain("Product");
    expect(prompt.mock.calls[1]?.[0]).toContain("Press Enter to use 1 (Engineering), or type 1-8");
  });

  it("supports a typed employee email and custom team", async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("other@example.com")
      .mockResolvedValueOnce("8")
      .mockResolvedValueOnce("AI Platform");

    const result = await resolveFirstRunSetupIdentity(
      { employeeEmail: "workspace@example.com", teamName: "Engineering" },
      { interactive: true, gitEmail: () => undefined, prompt },
    );

    expect(result).toEqual({ employeeEmail: "other@example.com", teamName: "AI Platform" });
  });

  it("accepts inferred defaults without prompts for automation", async () => {
    const prompt = vi.fn();

    const result = await resolveFirstRunSetupIdentity(
      { acceptDefaults: true, teamName: "engineering" },
      { interactive: true, gitEmail: () => "developer@example.com", prompt },
    );

    expect(result).toEqual({ employeeEmail: "developer@example.com", teamName: "Engineering" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("asks the user to confirm identity choices on repeated interactive setup", async () => {
    const prompt = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("");

    const result = await resolveFirstRunSetupIdentity(
      { employeeEmail: "Saved@Example.com", teamName: "Product" },
      { interactive: true, gitEmail: () => "other@example.com", prompt },
    );

    expect(result).toEqual({ employeeEmail: "saved@example.com", teamName: "Product" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("requires explicit approval for telemetry, service installation, and an opted-in backfill", async () => {
    const prompt = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("").mockResolvedValueOnce("y");

    const result = await confirmSetupPlan(
      { agent: "codex", service: true, backfillDays: 7 },
      { interactive: true, prompt },
    );

    expect(result).toEqual({ service: true, backfill: true });
    expect(prompt.mock.calls[0]?.[0]).toContain("Configure Codex telemetry");
    expect(prompt.mock.calls[1]?.[0]).toContain("background service");
    expect(prompt.mock.calls[2]?.[0]).toContain("best-effort local Codex history");
  });

  it("does not run an implicit backfill when unattended defaults are accepted", async () => {
    await expect(confirmSetupPlan({ agent: "codex", service: true, acceptDefaults: true })).resolves.toEqual({
      service: true,
      backfill: false,
    });
  });
});

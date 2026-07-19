import { describe, expect, it, vi } from "vitest";
import { resolveFirstRunSetupIdentity } from "../src/identity";

describe("collector first-run identity", () => {
  it("asks which email to use when the requested and Git emails differ", async () => {
    const prompt = vi.fn().mockResolvedValueOnce("2").mockResolvedValueOnce("");

    const result = await resolveFirstRunSetupIdentity(
      { employeeEmail: "workspace@example.com", teamName: "Engineering" },
      {
        interactive: true,
        configExists: () => false,
        gitEmail: () => "developer@example.com",
        prompt,
      },
    );

    expect(result).toEqual({ employeeEmail: "developer@example.com", teamName: "Engineering" });
    expect(prompt.mock.calls[0]?.[0]).toContain("workspace@example.com");
    expect(prompt.mock.calls[0]?.[0]).toContain("developer@example.com");
    expect(prompt.mock.calls[1]?.[0]).toContain("Engineering (selected)");
    expect(prompt.mock.calls[1]?.[0]).toContain("Product");
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
      { interactive: true, configExists: () => false, gitEmail: () => undefined, prompt },
    );

    expect(result).toEqual({ employeeEmail: "other@example.com", teamName: "AI Platform" });
  });

  it("accepts inferred defaults without prompts for automation", async () => {
    const prompt = vi.fn();

    const result = await resolveFirstRunSetupIdentity(
      { acceptDefaults: true, teamName: "engineering" },
      { interactive: true, configExists: () => false, gitEmail: () => "developer@example.com", prompt },
    );

    expect(result).toEqual({ employeeEmail: "developer@example.com", teamName: "Engineering" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not prompt after setup has created a config", async () => {
    const prompt = vi.fn();

    const result = await resolveFirstRunSetupIdentity(
      { employeeEmail: "Saved@Example.com", teamName: "Product" },
      { interactive: true, configExists: () => true, gitEmail: () => "other@example.com", prompt },
    );

    expect(result).toEqual({ employeeEmail: "saved@example.com", teamName: "Product" });
    expect(prompt).not.toHaveBeenCalled();
  });
});

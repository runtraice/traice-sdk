import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  credentialAccount,
  deleteCliCredential,
  resolveCliCredential,
  storeCliCredential,
  type CliCredentialDependencies,
} from "../src/cli-credentials";

describe("CLI credentials", () => {
  let directory: string;
  let configPath: string;
  let password: string | undefined;
  let dependencies: CliCredentialDependencies;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "traice-cli-"));
    configPath = path.join(directory, "config.json");
    password = undefined;
    delete process.env.TRAICE_API_KEY;
    delete process.env.TRAICE_SERVER_URL;
    dependencies = {
      createKeyringEntry: () => ({
        setPassword: async (value) => {
          password = value;
        },
        getPassword: async () => password,
        deletePassword: async () => {
          password = undefined;
        },
      }),
    };
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.TRAICE_API_KEY;
    delete process.env.TRAICE_SERVER_URL;
  });

  it("stores and retrieves an API key through the OS keyring reference", async () => {
    const stored = await storeCliCredential("lm_live_secret", "https://www.runtraice.com", configPath, dependencies);
    const resolved = await resolveCliCredential(undefined, configPath, dependencies);

    expect(stored.backend).toBe("os-keyring");
    expect(resolved).toEqual({
      apiKey: "lm_live_secret",
      serverUrl: "https://www.runtraice.com",
      source: "os-keyring",
    });
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("lm_live_secret");
  });

  it("falls back to a protected file when the native keyring is unavailable", async () => {
    const stored = await storeCliCredential("lm_live_secret", undefined, configPath, {
      createKeyringEntry: () => {
        throw new Error("unavailable");
      },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      credential: { path: string };
    };

    expect(stored.backend).toBe("protected-file");
    expect(stored.warning).toContain("unavailable");
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(config.credential.path).mode & 0o777).toBe(0o600);
  });

  it("prefers an ephemeral environment key without persisting it", async () => {
    process.env.TRAICE_API_KEY = "lm_live_environment";
    const resolved = await resolveCliCredential(undefined, configPath, dependencies);
    expect(resolved.source).toBe("environment");
    expect(resolved.apiKey).toBe("lm_live_environment");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("deletes the saved keyring credential and config", async () => {
    await storeCliCredential("lm_live_secret", undefined, configPath, dependencies);
    expect(await deleteCliCredential(configPath, dependencies)).toBe(true);
    expect(password).toBeUndefined();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("uses a stable server-scoped keyring account", () => {
    expect(credentialAccount("https://www.runtraice.com")).toMatch(/^server-[a-f0-9]{24}$/);
  });
});

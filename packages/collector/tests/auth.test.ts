import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loginAndStoreCollectorAuthorization,
  loginCollectorOAuth,
  logoutCollector,
  parseOAuthCredential,
  resolveCollectorAccessToken,
  serializeOAuthCredential,
  type CollectorOAuthTokenBundle,
} from "../src/auth";
import { buildDefaultConfig, loadCollectorConfig, writeCollectorConfig } from "../src/config";
import { readCollectorCredential, storeCollectorCredential } from "../src/credentials";
import { forwardEvents } from "../src/run";
import type { CollectorConfig } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("collector OAuth", () => {
  it("opens the verification link and polls through authorization_pending", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://runtraice.com/device",
          verification_uri_complete: "https://runtraice.com/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "authorization_pending", error_description: "Authorization is still pending." },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "temporarily_unavailable", error_description: "Try again shortly." }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "tr_oauth_at_secret",
          refresh_token: "tr_oauth_rt_secret",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "collector:status internal_usage:dedupe internal_usage:write",
          workspace: { id: "workspace-1", name: "Acme" },
          user: { email: "alex@acme.com" },
        }),
      );
    const report = vi.fn();
    const openBrowser = vi.fn(() => true);
    const sleep = vi.fn(async () => {});

    const result = await loginCollectorOAuth(
      { serverUrl: "https://runtraice.com" },
      { fetchImpl, report, openBrowser, sleep, now: () => Date.parse("2026-07-23T09:00:00.000Z") },
    );

    expect(result.workspace).toEqual({ id: "workspace-1", name: "Acme" });
    expect(result.user.email).toBe("alex@acme.com");
    expect(result.bundle.accessToken).toBe("tr_oauth_at_secret");
    expect(openBrowser).toHaveBeenCalledWith("https://runtraice.com/device?user_code=ABCD-EFGH");
    expect(report).toHaveBeenCalledWith("Enter code: ABCD-EFGH");
    expect(sleep).toHaveBeenCalledTimes(3);
    const deviceRequest = fetchImpl.mock.calls[0][1];
    expect(String(deviceRequest?.body)).toContain("internal_usage%3Adedupe");
  });

  it("supports SSH login without attempting to open a browser", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://runtraice.com/device",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "tr_oauth_at_secret",
          refresh_token: "tr_oauth_rt_secret",
          expires_in: 3600,
          scope: "collector:status internal_usage:dedupe internal_usage:write",
          workspace: { id: "workspace-1", name: "Acme" },
          user: { email: "alex@acme.com" },
        }),
      );
    const openBrowser = vi.fn(() => true);
    const report = vi.fn();

    await loginCollectorOAuth(
      { serverUrl: "https://runtraice.com", noBrowser: true },
      {
        fetchImpl,
        report,
        openBrowser,
        sleep: async () => {},
        now: () => Date.parse("2026-07-23T09:00:00.000Z"),
      },
    );

    expect(openBrowser).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("Open https://runtraice.com/device");
  });

  it("stores the token bundle outside the collector config", async () => {
    const directory = temporaryDirectory("traice-oauth-login-");
    const configPath = join(directory, "config.json");
    const fetchImpl = successfulLoginFetch();

    const result = await loginAndStoreCollectorAuthorization(
      { configPath, serverUrl: "https://runtraice.com", credentialStore: "file", noBrowser: true },
      {
        fetchImpl,
        report: () => {},
        sleep: async () => {},
        now: () => Date.parse("2026-07-23T09:00:00.000Z"),
      },
    );

    const configText = readFileSync(configPath, "utf8");
    expect(configText).not.toContain("tr_oauth_at_secret");
    expect(configText).not.toContain("tr_oauth_rt_secret");
    expect(result.authorization).toMatchObject({
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      userEmail: "alex@acme.com",
    });
    const stored = parseOAuthCredential(await readCollectorCredential(result.credential));
    expect(stored.accessToken).toBe("tr_oauth_at_secret");
    expect(stored.refreshToken).toBe("tr_oauth_rt_secret");
  });

  it("stores named workspace profiles in separate credential entries", async () => {
    const directory = temporaryDirectory("traice-oauth-profiles-");
    const configPath = join(directory, "config.json");
    await loginAndStoreCollectorAuthorization(
      { configPath, serverUrl: "https://runtraice.com", credentialStore: "file", noBrowser: true },
      {
        fetchImpl: successfulLoginFetch(),
        report: () => {},
        sleep: async () => {},
        now: () => Date.parse("2030-07-23T09:00:00.000Z"),
      },
    );
    await loginAndStoreCollectorAuthorization(
      {
        configPath,
        serverUrl: "https://runtraice.com",
        credentialStore: "file",
        noBrowser: true,
        profile: "test-zoro",
      },
      {
        fetchImpl: successfulLoginFetch(),
        report: () => {},
        sleep: async () => {},
        now: () => Date.parse("2030-07-23T09:01:00.000Z"),
      },
    );

    const config = loadCollectorConfig(configPath);
    expect(config.authorization?.workspaceName).toBe("Acme");
    expect(config.profiles?.["test-zoro"]?.authorization?.workspaceName).toBe("Acme");
    expect(config.profiles?.["test-zoro"]?.credential).not.toEqual(config.credential);
    expect(config.profiles?.["test-zoro"]?.credential).toMatchObject({
      backend: "protected-file",
    });
    expect(await readCollectorCredential(config.credential!)).toContain("tr_oauth_at_secret");
    expect(await readCollectorCredential(config.profiles!["test-zoro"]!.credential!)).toContain("tr_oauth_at_secret");

    const revoke = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    await expect(logoutCollector(configPath, revoke, "test-zoro")).resolves.toEqual({
      removed: true,
      remoteRevoked: true,
    });
    const afterLogout = loadCollectorConfig(configPath);
    expect(afterLogout.profiles?.["test-zoro"]).toBeUndefined();
    expect(afterLogout.authorization?.workspaceName).toBe("Acme");
    expect(await readCollectorCredential(afterLogout.credential!)).toContain("tr_oauth_at_secret");
  });

  it("refreshes an expiring access token and persists the rotated bundle", async () => {
    const directory = temporaryDirectory("traice-oauth-refresh-");
    const configPath = join(directory, "config.json");
    const config = await oauthConfig(configPath, {
      accessToken: "tr_oauth_at_old",
      refreshToken: "tr_oauth_rt_old",
      expiresAt: "2026-07-23T09:00:30.000Z",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(String(init?.body)).toContain("refresh_token=tr_oauth_rt_old");
      return Response.json({
        access_token: "tr_oauth_at_new",
        refresh_token: "tr_oauth_rt_new",
        expires_in: 3600,
        scope: "collector:status internal_usage:dedupe internal_usage:write",
      });
    });

    await expect(
      resolveCollectorAccessToken(configPath, {
        fetchImpl,
        now: () => Date.parse("2026-07-23T09:00:00.000Z"),
      }),
    ).resolves.toBe("tr_oauth_at_new");
    const stored = parseOAuthCredential(await readCollectorCredential(config.credential!));
    expect(stored).toMatchObject({
      accessToken: "tr_oauth_at_new",
      refreshToken: "tr_oauth_rt_new",
      expiresAt: "2026-07-23T10:00:00.000Z",
    });
  });

  it("recovers a refresh lock left behind by a crashed process", async () => {
    const directory = temporaryDirectory("traice-oauth-stale-lock-");
    const configPath = join(directory, "config.json");
    await oauthConfig(configPath, {
      accessToken: "tr_oauth_at_old",
      refreshToken: "tr_oauth_rt_old",
      expiresAt: "2026-07-23T09:00:30.000Z",
    });
    const lockPath = join(directory, ".oauth-refresh.lock");
    writeFileSync(lockPath, "");
    const staleTime = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath, staleTime, staleTime);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: "tr_oauth_at_new",
        refresh_token: "tr_oauth_rt_new",
        expires_in: 3600,
        scope: "collector:status internal_usage:dedupe internal_usage:write",
      }),
    );

    await expect(
      resolveCollectorAccessToken(configPath, {
        fetchImpl,
        now: () => Date.parse("2026-07-23T09:00:00.000Z"),
      }),
    ).resolves.toBe("tr_oauth_at_new");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refreshes once and retries a batch after a 401", async () => {
    const getAccessToken = vi.fn(async (forceRefresh = false) =>
      forceRefresh ? "tr_oauth_at_new" : getAccessToken.mock.calls.length > 1 ? "tr_oauth_at_new" : "tr_oauth_at_old",
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "invalid_token" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ accepted: 1 }));

    await expect(
      forwardEvents(
        { ...buildDefaultConfig(), serverUrl: "https://runtraice.com" },
        [
          {
            occurredAt: "2026-07-23T09:00:00.000Z",
            sourceKey: "codex-local",
            sourceName: "Codex local collector",
            sourceKind: "codex_otel",
            tool: "codex",
            category: "coding_agent",
            sourceEventId: "event-1",
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            costBasis: "usage_only",
          },
        ],
        { fetchImpl, getAccessToken },
      ),
    ).resolves.toBe(1);
    expect(getAccessToken).toHaveBeenCalledWith(true);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer tr_oauth_at_new");
  });

  it("revokes the remote grant and removes the local credential on logout", async () => {
    const directory = temporaryDirectory("traice-oauth-logout-");
    const configPath = join(directory, "config.json");
    const config = await oauthConfig(configPath, {
      accessToken: "tr_oauth_at_current",
      refreshToken: "tr_oauth_rt_current",
      expiresAt: "2030-07-23T10:00:00.000Z",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("DELETE");
      return Response.json({ ok: true });
    });

    await expect(logoutCollector(configPath, fetchImpl)).resolves.toEqual({
      removed: true,
      remoteRevoked: true,
    });
    expect(loadCollectorConfig(configPath).authorization).toBeUndefined();
    await expect(readCollectorCredential(config.credential!)).rejects.toThrow();
  });
});

function successfulLoginFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://runtraice.com/device",
        expires_in: 600,
        interval: 5,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        access_token: "tr_oauth_at_secret",
        refresh_token: "tr_oauth_rt_secret",
        expires_in: 3600,
        scope: "collector:status internal_usage:dedupe internal_usage:write",
        workspace: { id: "workspace-1", name: "Acme" },
        user: { email: "alex@acme.com" },
      }),
    );
}

async function oauthConfig(
  configPath: string,
  tokens: Pick<CollectorOAuthTokenBundle, "accessToken" | "refreshToken" | "expiresAt">,
) {
  const stored = await storeCollectorCredential(
    configPath,
    serializeOAuthCredential({
      version: 1,
      type: "oauth",
      ...tokens,
      scope: "collector:status internal_usage:dedupe internal_usage:write",
    }),
    "file",
  );
  const config: CollectorConfig = {
    ...buildDefaultConfig(new Date("2026-07-23T09:00:00.000Z")),
    serverUrl: "https://runtraice.com",
    credential: stored.credential,
    authorization: {
      type: "oauth",
      clientId: "traice-collector",
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      userEmail: "alex@acme.com",
      scopes: ["collector:status", "internal_usage:dedupe", "internal_usage:write"],
      authorizedAt: "2026-07-23T09:00:00.000Z",
    },
  };
  writeCollectorConfig(config, configPath);
  return config;
}

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

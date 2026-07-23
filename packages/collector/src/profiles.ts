import type { CollectorConfig, CollectorCredential, CollectorWorkspaceProfile } from "./types";

export const DEFAULT_PROFILE = "default";
const PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface CollectorProfileSummary {
  name: string;
  workspaceName?: string;
  workspaceId?: string;
  serverUrl: string;
  active: boolean;
  mirror: boolean;
  credentialBackend?: CollectorCredential["backend"];
}

export function normalizeProfileName(value = DEFAULT_PROFILE): string {
  const normalized = value.trim().toLowerCase();
  if (!PROFILE_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid profile "${value}". Use 1 to 64 lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return normalized;
}

export function activeProfileName(config: CollectorConfig): string {
  return normalizeProfileName(config.activeProfile ?? DEFAULT_PROFILE);
}

export function collectorProfile(config: CollectorConfig, requestedProfile?: string): CollectorWorkspaceProfile {
  const name = normalizeProfileName(requestedProfile ?? activeProfileName(config));
  if (name === DEFAULT_PROFILE) {
    if (!config.credential && !config.apiKey) {
      throw new Error('Collector profile "default" has no credential. Run auth login or select another profile.');
    }
    return {
      serverUrl: config.serverUrl,
      credential: config.credential,
      ...(config.authorization ? { authorization: config.authorization } : {}),
    };
  }
  const profile = config.profiles?.[name];
  if (!profile) throw new Error(`Collector profile "${name}" was not found.`);
  return profile;
}

export function configForProfile(config: CollectorConfig, requestedProfile?: string): CollectorConfig {
  const name = normalizeProfileName(requestedProfile ?? activeProfileName(config));
  const profile = collectorProfile(config, name);
  return {
    ...config,
    serverUrl: profile.serverUrl,
    credential: profile.credential,
    authorization: profile.authorization,
    ...(name === DEFAULT_PROFILE ? {} : { apiKey: undefined }),
  };
}

export function configuredProfileNames(config: CollectorConfig): string[] {
  return [
    ...(config.credential ? [DEFAULT_PROFILE] : []),
    ...(config.apiKey ? [DEFAULT_PROFILE] : []),
    ...Object.keys(config.profiles ?? {}).map(normalizeProfileName),
  ].filter((name, index, names) => names.indexOf(name) === index);
}

export function selectedProfileNames(
  config: CollectorConfig,
  options: { profile?: string; mirrorProfiles?: string[] } = {},
): string[] {
  const primary = normalizeProfileName(options.profile ?? activeProfileName(config));
  const mirrors = (options.mirrorProfiles ?? config.mirrorProfiles ?? []).map(normalizeProfileName);
  const selected = [primary, ...mirrors.filter((name) => name !== primary)];
  for (const name of selected) collectorProfile(config, name);
  return selected;
}

export function upsertCollectorProfile(
  config: CollectorConfig,
  requestedProfile: string,
  profile: CollectorWorkspaceProfile,
): CollectorConfig {
  const name = normalizeProfileName(requestedProfile);
  if (name === DEFAULT_PROFILE) {
    return {
      ...config,
      serverUrl: profile.serverUrl,
      credential: profile.credential,
      authorization: profile.authorization,
    };
  }
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [name]: profile,
    },
  };
}

export function removeCollectorProfile(config: CollectorConfig, requestedProfile: string): CollectorConfig {
  const name = normalizeProfileName(requestedProfile);
  if (name === DEFAULT_PROFILE) {
    const next = { ...config };
    delete next.credential;
    delete next.authorization;
    delete next.apiKey;
    if (activeProfileName(next) === DEFAULT_PROFILE) delete next.activeProfile;
    next.mirrorProfiles = (next.mirrorProfiles ?? []).filter((profile) => profile !== DEFAULT_PROFILE);
    return next;
  }
  const profiles = { ...config.profiles };
  delete profiles[name];
  const next: CollectorConfig = {
    ...config,
    profiles,
    mirrorProfiles: (config.mirrorProfiles ?? []).filter((profile) => profile !== name),
  };
  if (activeProfileName(config) === name) {
    next.activeProfile = config.credential || config.apiKey ? DEFAULT_PROFILE : configuredProfileNames(next)[0];
  }
  return next;
}

export function setActiveCollectorProfile(config: CollectorConfig, requestedProfile: string): CollectorConfig {
  const name = normalizeProfileName(requestedProfile);
  collectorProfile(config, name);
  return {
    ...config,
    activeProfile: name,
    mirrorProfiles: (config.mirrorProfiles ?? []).filter((profile) => profile !== name),
  };
}

export function setCollectorProfileMirror(
  config: CollectorConfig,
  requestedProfile: string,
  enabled: boolean,
): CollectorConfig {
  const name = normalizeProfileName(requestedProfile);
  collectorProfile(config, name);
  if (name === activeProfileName(config)) {
    throw new Error(`Collector profile "${name}" is already the active destination.`);
  }
  const mirrors = new Set((config.mirrorProfiles ?? []).map(normalizeProfileName));
  if (enabled) mirrors.add(name);
  else mirrors.delete(name);
  return { ...config, mirrorProfiles: [...mirrors] };
}

export function collectorProfileSummaries(config: CollectorConfig): CollectorProfileSummary[] {
  const active = activeProfileName(config);
  const mirrors = new Set((config.mirrorProfiles ?? []).map(normalizeProfileName));
  return configuredProfileNames(config).map((name) => {
    const profile = collectorProfile(config, name);
    return {
      name,
      serverUrl: profile.serverUrl,
      active: name === active,
      mirror: mirrors.has(name),
      ...(profile.credential ? { credentialBackend: profile.credential.backend } : {}),
      ...(profile.authorization
        ? {
            workspaceName: profile.authorization.workspaceName,
            workspaceId: profile.authorization.workspaceId,
          }
        : {}),
    };
  });
}

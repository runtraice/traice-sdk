import packageMetadata from "../package.json";
import { resolveConfigPath } from "./config";
import { installCollectorService, type CollectorServiceResult } from "./service";

const LATEST_PACKAGE_URL = "https://registry.npmjs.org/@traice%2fcollector/latest";

export interface CollectorUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export async function checkCollectorUpdate(
  fetchImpl: typeof fetch = fetch,
  currentVersion = packageMetadata.version,
): Promise<CollectorUpdateStatus> {
  const response = await fetchImpl(LATEST_PACKAGE_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Collector update check returned ${response.status}.`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !isSemver(body.version)) {
    throw new Error("The npm registry returned an invalid collector version.");
  }
  return {
    currentVersion,
    latestVersion: body.version,
    updateAvailable: compareSemver(body.version, currentVersion) > 0,
  };
}

export async function updateCollector(
  options: { configPath?: string; targetVersion?: string } = {},
  dependencies: {
    fetchImpl?: typeof fetch;
    installService?: typeof installCollectorService;
  } = {},
): Promise<CollectorUpdateStatus & { service?: CollectorServiceResult }> {
  const status = options.targetVersion
    ? {
        currentVersion: packageMetadata.version,
        latestVersion: validateVersion(options.targetVersion),
        updateAvailable: compareSemver(options.targetVersion, packageMetadata.version) !== 0,
      }
    : await checkCollectorUpdate(dependencies.fetchImpl);
  const service = (dependencies.installService ?? installCollectorService)({
    configPath: resolveConfigPath(options.configPath),
    packageVersion: status.latestVersion,
  });
  return { ...status, service };
}

function validateVersion(value: string): string {
  if (!isSemver(value)) throw new Error(`Invalid collector version "${value}".`);
  return value;
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split("-", 1)[0]!.split(".").map(Number);
  const rightParts = right.split("-", 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

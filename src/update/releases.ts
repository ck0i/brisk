export const RELEASE_REPOSITORY = "nickt/brisk";
export const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;

const VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_RELEASE_ASSET_SIZE = 512 * 1024 * 1024;

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
}

export interface BriskRelease {
  readonly version: string;
  readonly tagName: string;
  readonly htmlUrl: string;
  readonly assets: readonly ReleaseAsset[];
}
export type ReleaseFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseRequestOptions {
  readonly fetch?: ReleaseFetch;
  readonly signal?: AbortSignal;
  readonly apiUrl?: string;
}

export async function checkForUpdate(
  currentVersion: string,
  options: ReleaseRequestOptions = {},
): Promise<BriskRelease | undefined> {
  const release = await fetchLatestRelease(options);
  return compareVersions(release.version, currentVersion) > 0 ? release : undefined;
}

export async function fetchLatestRelease(
  options: ReleaseRequestOptions = {},
): Promise<BriskRelease> {
  const request = options.fetch ?? globalThis.fetch;
  const response = await request(options.apiUrl ?? RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "brisk-update-check",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: options.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}`);
  }

  const value: unknown = await response.json();
  return parseRelease(value);
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) break;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function parseRelease(value: unknown): BriskRelease {
  if (!isRecord(value)) throw new Error("GitHub returned an invalid release document");
  if (value.draft === true || value.prerelease === true) {
    throw new Error("GitHub returned a non-current release");
  }

  const tagName = requireString(value.tag_name, "release tag_name");
  const version = normalizeVersion(tagName);
  const htmlUrl = requireHttpsUrl(value.html_url, "release html_url", "github.com");
  if (!Array.isArray(value.assets)) throw new Error("GitHub release assets must be an array");

  const assets: ReleaseAsset[] = [];
  const names = new Set<string>();
  for (const candidate of value.assets) {
    if (!isRecord(candidate)) throw new Error("GitHub returned an invalid release asset");
    const name = requireString(candidate.name, "release asset name");
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new Error(`GitHub returned an unsafe release asset name: ${JSON.stringify(name)}`);
    }
    if (names.has(name)) throw new Error(`GitHub returned duplicate release asset ${name}`);
    names.add(name);

    const url = requireHttpsUrl(
      candidate.browser_download_url,
      `${name} download URL`,
      "github.com",
    );
    const size = candidate.size;
    if (!Number.isSafeInteger(size) || Number(size) <= 0 || Number(size) > MAX_RELEASE_ASSET_SIZE) {
      throw new Error(`GitHub returned an invalid size for release asset ${name}`);
    }
    assets.push({ name, url, size: Number(size) });
  }

  return { version, tagName, htmlUrl, assets };
}

function normalizeVersion(value: string): string {
  const match = VERSION_PATTERN.exec(value);
  if (!match)
    throw new Error(`Release tag ${JSON.stringify(value)} is not a stable semantic version`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function parseVersion(value: string): readonly bigint[] {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid Brisk version: ${JSON.stringify(value)}`);
  return [BigInt(match[1] ?? "0"), BigInt(match[2] ?? "0"), BigInt(match[3] ?? "0")];
}

function requireString(value: unknown, description: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    hasControlCharacter(value)
  ) {
    throw new Error(`GitHub returned an invalid ${description}`);
  }
  return value;
}

function requireHttpsUrl(value: unknown, description: string, hostname: string): string {
  const rendered = requireString(value, description);
  let url: URL;
  try {
    url = new URL(rendered);
  } catch {
    throw new Error(`GitHub returned an invalid ${description}`);
  }
  if (url.protocol !== "https:" || url.hostname !== hostname || url.username || url.password) {
    throw new Error(`GitHub returned an untrusted ${description}`);
  }
  return url.href;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  AuthCredentialEntry,
  CredentialOrigin,
  OAuthAuthInfo,
  OAuthLoginIdentity,
  OAuthPrompt,
  OAuthProviderId,
} from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth";

import {
  AuthService,
  BUILT_IN_BRISK_OAUTH_PROVIDERS,
  type AuthStorageLike,
} from "../../src/providers/auth-service.ts";
import type { ApiKeyResolutionOptions } from "../../src/providers/pi-ai-provider.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

class FakeAuthStorage implements AuthStorageLike {
  readonly origins = new Map<string, CredentialOrigin>();
  readonly credentials = new Map<string, string>();
  reloadCount = 0;
  closeCount = 0;
  logoutProvider: string | undefined;
  failAfterPrompt = false;
  sawManualCode = false;

  async reload(): Promise<void> {
    this.reloadCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  list(): string[] {
    return [...this.origins.keys()];
  }

  hasAuth(provider: string): boolean {
    return this.origins.has(provider);
  }

  getCredentialOrigin(provider: string): CredentialOrigin | undefined {
    return this.origins.get(provider);
  }

  async login(
    provider: OAuthProviderId,
    controller: {
      readonly onAuth: (info: OAuthAuthInfo) => void;
      readonly onProgress?: (message: string) => void;
      readonly onManualCodeInput?: () => Promise<string>;
      readonly onPrompt: (prompt: OAuthPrompt) => Promise<string>;
      readonly signal?: AbortSignal;
    },
  ): Promise<OAuthLoginIdentity> {
    controller.onAuth({ url: "https://login.test/authorize?state=BRISK_TEST_STATE" });
    controller.onProgress?.("waiting");
    const answer = await controller.onPrompt({ message: "account" });
    if (controller.onManualCodeInput) {
      this.sawManualCode = (await controller.onManualCodeInput()) === "BRISK_TEST_MANUAL_CODE";
    }
    if (this.failAfterPrompt) throw new Error(`login failed with access_token=${answer}`);
    this.origins.set(provider, { kind: "oauth" });
    return { type: "oauth", email: "user@example.test", accountId: "account-test" };
  }

  async logout(provider: string): Promise<void> {
    this.logoutProvider = provider;
    this.origins.delete(provider);
    this.credentials.delete(provider);
  }

  async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
    const first = Array.isArray(credential) ? credential[0] : credential;
    if (first?.type !== "api_key") throw new Error("expected api key");
    this.credentials.set(provider, first.key);
    this.origins.set(provider, { kind: "api_key" });
  }

  async getApiKey(
    provider: string,
    _sessionId?: string,
    _options?: ApiKeyResolutionOptions,
  ): Promise<string | undefined> {
    return this.credentials.get(provider);
  }
}

const oauthProviders: readonly OAuthProviderInfo[] = BUILT_IN_BRISK_OAUTH_PROVIDERS.map((id) => ({
  id,
  name: id,
  available: true,
}));

describe("AuthService", () => {
  test("initializes secure storage, orchestrates OAuth callbacks, status, and logout", async () => {
    const fake = new FakeAuthStorage();
    const { service, dbPath, parent } = await initialize(fake);
    const progress: string[] = [];
    const opened: string[] = [];

    const identity = await service.login("anthropic", {
      openBrowser(info) {
        opened.push(info.url);
      },
      async prompt() {
        return "BRISK_TEST_PROMPT_RESPONSE";
      },
      async manualCode() {
        return "BRISK_TEST_MANUAL_CODE";
      },
      progress(message) {
        progress.push(message);
      },
    });

    expect(identity).toEqual({
      type: "oauth",
      email: "user@example.test",
      accountId: "account-test",
    });
    expect(opened).toHaveLength(1);
    expect(progress).toEqual(["waiting"]);
    expect(fake.sawManualCode).toBe(true);
    expect(service.hasAuth("anthropic")).toBe(true);
    expect(service.listProviderStatus(["anthropic"])).toEqual([
      {
        provider: "anthropic",
        credentialProvider: "anthropic",
        name: "anthropic",
        configured: true,
        source: "oauth",
        oauth: true,
        oauthAvailable: true,
      },
    ]);
    expect(JSON.stringify(service.listProviderStatus(["anthropic"]))).not.toContain(
      "BRISK_TEST_PROMPT_RESPONSE",
    );
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    expect(fake.reloadCount).toBe(1);

    await service.logout("anthropic");
    expect(fake.logoutProvider).toBe("anthropic");
    expect(service.hasAuth("anthropic")).toBe(false);
    service.close();
    service.close();
    expect(fake.closeCount).toBe(1);
  });

  test("validates OAuth providers against the upstream provider list", async () => {
    const fake = new FakeAuthStorage();
    const { service } = await initialize(fake);

    await expect(
      service.login("not-a-provider", {
        openBrowser() {},
        async prompt() {
          return "";
        },
      }),
    ).rejects.toThrow("OAuth provider is unavailable");

    service.close();
  });

  test("the installed upstream exposes every required built-in OAuth id", async () => {
    const fake = new FakeAuthStorage();
    const root = await makeTemporaryDirectory();
    const dbPath = join(root, "auth", "brisk.db");
    const service = await AuthService.initialize(dbPath, {
      createStorage: async (path) => {
        await writeFile(path, "");
        return fake;
      },
      envProviders: () => [],
    });

    const status = service.listProviderStatus(BUILT_IN_BRISK_OAUTH_PROVIDERS);
    expect(status.map((entry) => entry.provider)).toEqual([...BUILT_IN_BRISK_OAUTH_PROVIDERS]);
    expect(status.every((entry) => entry.oauth && entry.oauthAvailable)).toBe(true);
    service.close();
  });

  test("imports an upstream-resolved environment fallback without returning or listing it", async () => {
    const secret = "BRISK_TEST_ENV_KEY";
    const fake = new FakeAuthStorage();
    const { service } = await initialize(fake, { envApiKey: () => secret });

    expect(await service.importApiKeyFromEnvironment("openai")).toBe(true);
    expect(fake.credentials.get("openai")).toBe(secret);
    expect(service.listProviderStatus(["openai"])).toEqual([
      {
        provider: "openai",
        credentialProvider: "openai",
        configured: true,
        source: "api_key",
        oauth: false,
        oauthAvailable: false,
      },
    ]);
    expect(JSON.stringify(service.listProviderStatus(["openai"]))).not.toContain(secret);
    service.close();
  });

  test("uses pi-ai's exact provider environment mapping by default", async () => {
    const secret = "BRISK_TEST_UPSTREAM_ENV_KEY";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    const fake = new FakeAuthStorage();
    const root = await makeTemporaryDirectory();
    const dbPath = join(root, "auth", "brisk.db");
    try {
      const service = await AuthService.initialize(dbPath, {
        createStorage: async (path) => {
          await writeFile(path, "");
          return fake;
        },
        oauthProviders: () => oauthProviders,
        envProviders: () => [],
      });
      expect(await service.importApiKeyFromEnvironment("openai")).toBe(true);
      expect(fake.credentials.get("openai")).toBe(secret);
      service.close();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("redacts prompt responses from OAuth failures", async () => {
    const secret = "BRISK_TEST_LOGIN_RESPONSE";
    const fake = new FakeAuthStorage();
    fake.failAfterPrompt = true;
    const { service } = await initialize(fake);

    let caught: unknown;
    try {
      await service.login("anthropic", {
        openBrowser() {},
        async prompt() {
          return secret;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
    service.close();
  });
});

async function initialize(
  fake: FakeAuthStorage,
  overrides: { readonly envApiKey?: (provider: string) => string | undefined } = {},
): Promise<{ service: AuthService; dbPath: string; parent: string }> {
  const root = await makeTemporaryDirectory();
  const parent = join(root, "auth");
  const dbPath = join(parent, "brisk.db");
  const service = await AuthService.initialize(dbPath, {
    createStorage: async (path) => {
      await writeFile(path, "");
      return fake;
    },
    oauthProviders: () => oauthProviders,
    envProviders: () => [],
    envApiKey: overrides.envApiKey ?? (() => undefined),
  });
  return { service, dbPath, parent };
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "brisk-auth-test-"));
  temporaryDirectories.push(path);
  return path;
}

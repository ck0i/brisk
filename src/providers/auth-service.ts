import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AuthStorage,
  getEnvApiKey,
  listProvidersWithEnvKey,
  type AuthCredentialEntry,
  type CredentialOrigin,
  type OAuthAuthInfo,
  type OAuthController,
  type OAuthLoginIdentity,
  type OAuthPrompt,
  type OAuthProviderId,
} from "@oh-my-pi/pi-ai";
import { getOAuthProviders, type OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth";

import type { ApiKeyResolutionOptions, CredentialResolver } from "./pi-ai-provider.ts";
import { redactedErrorMessage } from "./secret-redaction.ts";

export const BUILT_IN_BRISK_OAUTH_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "google-antigravity",
  "cursor",
] as const;

export interface AuthPrompter {
  openBrowser(info: OAuthAuthInfo): void;
  prompt(prompt: OAuthPrompt): Promise<string>;
  manualCode?(): Promise<string>;
  progress?(message: string): void;
}

/** The intentionally small AuthStorage surface Brisk orchestration consumes. */
export interface AuthStorageLike extends CredentialResolver {
  reload(): Promise<void>;
  close(): void;
  list(): string[];
  hasAuth(provider: string): boolean;
  getCredentialOrigin(provider: string): CredentialOrigin | undefined;
  login(
    provider: OAuthProviderId,
    controller: OAuthController & {
      readonly onAuth: (info: OAuthAuthInfo) => void;
      readonly onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    },
  ): Promise<OAuthLoginIdentity | undefined>;
  logout(provider: string): Promise<void>;
  set(provider: string, credential: AuthCredentialEntry): Promise<void>;
}

export interface ProviderAuthStatus {
  readonly provider: string;
  readonly credentialProvider: string;
  readonly name?: string;
  readonly configured: boolean;
  readonly source?: CredentialOrigin["kind"];
  readonly envVar?: string;
  readonly oauth: boolean;
  readonly oauthAvailable: boolean;
}

export interface AuthServiceDependencies {
  readonly createStorage?: (dbPath: string) => Promise<AuthStorageLike>;
  readonly oauthProviders?: () => readonly OAuthProviderInfo[];
  readonly envApiKey?: (provider: string) => string | undefined;
  readonly envProviders?: () => readonly string[];
}

/** Owns a pi-ai AuthStorage located at Brisk's caller-selected database path. */
export class AuthService implements CredentialResolver {
  readonly dbPath: string;
  private closed = false;

  private constructor(
    dbPath: string,
    private readonly storage: AuthStorageLike,
    private readonly dependencies: Required<AuthServiceDependencies>,
  ) {
    this.dbPath = dbPath;
  }

  static async initialize(
    dbPath: string,
    dependencies: AuthServiceDependencies = {},
  ): Promise<AuthService> {
    const absolutePath = resolve(dbPath);
    const parent = dirname(absolutePath);
    let storage: AuthStorageLike | undefined;
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const resolvedDependencies: Required<AuthServiceDependencies> = {
        createStorage: dependencies.createStorage ?? ((path) => AuthStorage.create(path)),
        oauthProviders: dependencies.oauthProviders ?? getOAuthProviders,
        envApiKey: dependencies.envApiKey ?? getEnvApiKey,
        envProviders: dependencies.envProviders ?? listProvidersWithEnvKey,
      };
      storage = await resolvedDependencies.createStorage(absolutePath);
      await storage.reload();
      await chmod(absolutePath, 0o600);
      return new AuthService(absolutePath, storage, resolvedDependencies);
    } catch (error) {
      try {
        storage?.close();
      } catch {
        // Preserve the initialization failure without exposing a close-time detail.
      }
      throw sanitizedAuthError(error, [], "Failed to initialize authentication storage");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.storage.close();
    } catch (error) {
      throw sanitizedAuthError(error, [], "Failed to close authentication storage");
    }
  }

  hasAuth(provider: string): boolean {
    this.assertOpen();
    try {
      return this.storage.hasAuth(provider);
    } catch (error) {
      throw sanitizedAuthError(error, [], `Failed to inspect authentication for ${provider}`);
    }
  }

  listProviderStatus(providers?: readonly string[]): readonly ProviderAuthStatus[] {
    this.assertOpen();
    try {
      const oauthById = new Map(
        this.dependencies.oauthProviders().map((provider) => [provider.id, provider]),
      );
      const ids =
        providers ??
        [
          ...new Set([
            ...this.dependencies.envProviders(),
            ...this.storage.list(),
            ...oauthById.keys(),
          ]),
        ].sort();

      return ids.map((provider) => {
        const oauth = oauthById.get(provider);
        const credentialProvider = oauth?.storeCredentialsAs ?? provider;
        const origin = this.storage.getCredentialOrigin(credentialProvider);
        return {
          provider,
          credentialProvider,
          ...(oauth === undefined ? {} : { name: oauth.name }),
          configured: this.storage.hasAuth(credentialProvider),
          ...(origin === undefined ? {} : { source: origin.kind }),
          ...(origin?.envVar === undefined ? {} : { envVar: origin.envVar }),
          oauth: oauth !== undefined,
          oauthAvailable: oauth?.available ?? false,
        };
      });
    } catch (error) {
      throw sanitizedAuthError(error, [], "Failed to list authentication status");
    }
  }

  async login(
    provider: string,
    prompter: AuthPrompter,
    signal?: AbortSignal,
  ): Promise<OAuthLoginIdentity | undefined> {
    this.assertOpen();
    const secrets: string[] = [];
    try {
      const info = this.dependencies
        .oauthProviders()
        .find((candidate) => candidate.id === provider);
      if (!info || !info.available) {
        throw new Error(`OAuth provider is unavailable: ${provider}`);
      }
      return await this.storage.login(provider, {
        onAuth: (authInfo) => {
          secrets.push(authInfo.url);
          if (authInfo.launchUrl !== undefined) secrets.push(authInfo.launchUrl);
          prompter.openBrowser(authInfo);
        },
        onPrompt: async (prompt) => {
          const answer = await prompter.prompt(prompt);
          secrets.push(answer);
          return answer;
        },
        ...(prompter.manualCode === undefined
          ? {}
          : {
              onManualCodeInput: async () => {
                const answer = await prompter.manualCode?.();
                const resolved = answer ?? "";
                secrets.push(resolved);
                return resolved;
              },
            }),
        ...(prompter.progress === undefined
          ? {}
          : { onProgress: (message: string) => prompter.progress?.(message) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw sanitizedAuthError(error, secrets, `OAuth login failed for ${provider}`);
    }
  }

  async logout(provider: string): Promise<void> {
    this.assertOpen();
    try {
      await this.storage.logout(provider);
    } catch (error) {
      throw sanitizedAuthError(error, [], `Logout failed for ${provider}`);
    }
  }

  async storeApiKey(provider: string, apiKey: string): Promise<void> {
    this.assertOpen();
    if (apiKey.length === 0) throw new TypeError("API key cannot be empty");
    try {
      await this.storage.set(provider, { type: "api_key", key: apiKey, source: "login" });
    } catch (error) {
      throw sanitizedAuthError(error, [apiKey], `Failed to store API key for ${provider}`);
    }
  }

  /** Persist the key resolved by pi-ai's provider-specific environment mapping. */
  async importApiKeyFromEnvironment(provider: string): Promise<boolean> {
    this.assertOpen();
    let apiKey: string | undefined;
    try {
      apiKey = this.dependencies.envApiKey(provider);
      if (!apiKey) return false;
      await this.storeApiKey(provider, apiKey);
      return true;
    } catch (error) {
      throw sanitizedAuthError(
        error,
        apiKey === undefined ? [] : [apiKey],
        `Failed to import environment API key for ${provider}`,
      );
    }
  }

  async getApiKey(
    provider: string,
    sessionId?: string,
    options?: ApiKeyResolutionOptions,
  ): Promise<string | undefined> {
    this.assertOpen();
    try {
      return await this.storage.getApiKey(provider, sessionId, options);
    } catch (error) {
      throw sanitizedAuthError(error, [], `Failed to resolve authentication for ${provider}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Authentication service is closed");
  }
}

function sanitizedAuthError(error: unknown, secrets: readonly string[], fallback: string): Error {
  const sanitized = new Error(redactedErrorMessage(error, secrets, fallback));
  sanitized.name = "AuthServiceError";
  return sanitized;
}

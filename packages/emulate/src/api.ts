import {
  createServer,
  filePersistence as coreFilePersistence,
  restoreTokenMap,
  serve,
  type AppKeyResolver,
  type TokenEntry,
} from "@emulators/core";
import { SERVICE_REGISTRY } from "./registry.js";
export type { ServiceName } from "./registry.js";
import type { ServiceName } from "./registry.js";
import { resolveBaseUrl } from "./base-url.js";
import { createEmulatorPersistence, type EmulatorPersistence, type PersistenceAdapter } from "./persistence.js";

export type { PersistenceAdapter } from "./persistence.js";

export function filePersistence(path: string): PersistenceAdapter {
  return coreFilePersistence(path);
}

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

export interface EmulatorOptions {
  service: ServiceName;
  port?: number;
  seed?: SeedConfig;
  baseUrl?: string;
  persistence?: PersistenceAdapter;
}

export interface Emulator {
  url: string;
  reset(): void;
  close(): Promise<void>;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function seedTokenEntries(seedConfig: SeedConfig | undefined): TokenEntry[] {
  if (seedConfig?.tokens) {
    let tokenId = 100;
    return Object.entries(seedConfig.tokens).map(([token, user]) => ({
      token,
      login: user.login,
      id: tokenId++,
      scopes: user.scopes ?? ["repo", "user", "admin:org", "admin:repo_hook"],
    }));
  }

  return [
    {
      token: "test_token_admin",
      login: "admin",
      id: 2,
      scopes: ["repo", "user", "admin:org", "admin:repo_hook"],
    },
  ];
}

function closeServer(httpServer: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeWithPersistence(
  httpServer: ReturnType<typeof serve>,
  persistence: EmulatorPersistence | undefined,
): Promise<void> {
  let serverError: unknown;
  let hasServerError = false;
  try {
    await closeServer(httpServer);
  } catch (error) {
    serverError = error;
    hasServerError = true;
  }

  let persistenceError: unknown;
  let hasPersistenceError = false;
  try {
    await persistence?.flush();
  } catch (error) {
    persistenceError = error;
    hasPersistenceError = true;
  }

  if (hasServerError && hasPersistenceError) {
    throw new AggregateError([serverError, persistenceError], "Failed to close emulator and flush persisted state");
  }
  if (hasPersistenceError) throw persistenceError;
  if (hasServerError) throw serverError;
}

export async function createEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { service, port = 4000, seed: seedConfig, persistence: persistenceAdapter } = options;

  const entry = SERVICE_REGISTRY[service];
  if (!entry) {
    throw new Error(`Unknown service: ${service}`);
  }

  const loaded = await entry.load();

  const initialTokens = seedTokenEntries(seedConfig);

  const svcSeedConfig = seedConfig?.[service] as Record<string, unknown> | undefined;
  const seedBaseUrl =
    typeof svcSeedConfig?.baseUrl === "string" && svcSeedConfig.baseUrl.length > 0 ? svcSeedConfig.baseUrl : undefined;
  const baseUrl = resolveBaseUrl({ service, port, baseUrl: options.baseUrl, seedBaseUrl });

  // eslint-disable-next-line prefer-const -- reassigned after closure captures it
  let cachedResolver: AppKeyResolver | undefined;
  const appKeyResolver: AppKeyResolver | undefined = loaded.createAppKeyResolver
    ? (appId) => cachedResolver!(appId)
    : undefined;

  const fallbackUser = entry.defaultFallback(svcSeedConfig);

  const { app, store, tokenMap, webhooks } = createServer(loaded.plugin, {
    port,
    baseUrl,
    appKeyResolver,
    fallbackUser,
  });
  cachedResolver = loaded.createAppKeyResolver?.(store);

  const seed = () => {
    loaded.plugin.seed?.(store, baseUrl);
    if (svcSeedConfig && loaded.seedFromConfig) {
      loaded.seedFromConfig(store, baseUrl, svcSeedConfig, webhooks);
    }
  };
  const persistence = persistenceAdapter
    ? createEmulatorPersistence(persistenceAdapter, service, store, tokenMap)
    : undefined;
  const restored = (await persistence?.restore()) ?? false;
  if (!restored) {
    restoreTokenMap(tokenMap, initialTokens);
    seed();
    persistence?.enqueueSave();
  }

  const fetch = async (request: Request): Promise<Response> => {
    const response = await app.fetch(request);
    if (
      persistence &&
      MUTATING_METHODS.has(request.method.toUpperCase()) &&
      response.status >= 200 &&
      response.status < 400
    ) {
      persistence.enqueueSave();
    }
    return response;
  };
  const httpServer = serve({ fetch, port });

  return {
    url: baseUrl,
    reset() {
      store.reset();
      seed();
      persistence?.enqueueSave();
    },
    close() {
      return closeWithPersistence(httpServer, persistence);
    },
  };
}

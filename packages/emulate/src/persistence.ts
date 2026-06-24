import {
  restoreTokenMap,
  serializeTokenMap,
  type Store,
  type StoreSnapshot,
  type TokenEntry,
  type TokenMap,
} from "@emulators/core";
import type { ServiceName } from "./registry.js";

export interface PersistenceAdapter {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

interface PersistedEmulatorState {
  version: 1;
  service: ServiceName;
  store: StoreSnapshot;
  tokens: TokenEntry[];
}

const PERSISTENCE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoreSnapshot(value: unknown): value is StoreSnapshot {
  if (!isRecord(value) || !isRecord(value.collections) || !isRecord(value.data)) return false;

  return Object.values(value.collections).every(
    (collection) =>
      isRecord(collection) &&
      Array.isArray(collection.items) &&
      collection.items.every(
        (item) =>
          isRecord(item) &&
          Number.isSafeInteger(item.id) &&
          typeof item.created_at === "string" &&
          typeof item.updated_at === "string",
      ) &&
      Number.isSafeInteger(collection.autoId) &&
      (collection.autoId as number) > 0 &&
      Array.isArray(collection.indexFields) &&
      collection.indexFields.every((field) => typeof field === "string"),
  );
}

function isTokenEntry(value: unknown): value is TokenEntry {
  return (
    isRecord(value) &&
    typeof value.token === "string" &&
    typeof value.login === "string" &&
    Number.isSafeInteger(value.id) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string")
  );
}

function parseState(raw: string, service: ServiceName): PersistedEmulatorState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Invalid persisted emulator state: expected valid JSON", { cause });
  }

  if (!isRecord(value) || value.version !== PERSISTENCE_VERSION) {
    throw new Error(`Invalid persisted emulator state: expected version ${PERSISTENCE_VERSION}`);
  }
  if (value.service !== service) {
    throw new Error(`Invalid persisted emulator state: expected service ${service}`);
  }
  if (!isStoreSnapshot(value.store) || !Array.isArray(value.tokens) || !value.tokens.every(isTokenEntry)) {
    throw new Error("Invalid persisted emulator state: malformed store or token data");
  }

  return {
    version: PERSISTENCE_VERSION,
    service,
    store: value.store,
    tokens: value.tokens,
  };
}

function serializeState(service: ServiceName, store: Store, tokenMap: TokenMap): string {
  const state: PersistedEmulatorState = {
    version: PERSISTENCE_VERSION,
    service,
    store: store.snapshot(),
    tokens: serializeTokenMap(tokenMap),
  };
  return JSON.stringify(state);
}

export interface EmulatorPersistence {
  restore(): Promise<boolean>;
  enqueueSave(): void;
  flush(): Promise<void>;
}

export function createEmulatorPersistence(
  adapter: PersistenceAdapter,
  service: ServiceName,
  store: Store,
  tokenMap: TokenMap,
): EmulatorPersistence {
  let pendingSave: Promise<void> = Promise.resolve();
  let firstError: unknown;
  let hasError = false;

  const recordError = (error: unknown): void => {
    if (!hasError) {
      firstError = error;
      hasError = true;
    }
  };

  return {
    async restore() {
      const raw = await adapter.load();
      if (raw === null) return false;

      const state = parseState(raw, service);
      store.restore(state.store);
      restoreTokenMap(tokenMap, state.tokens);
      return true;
    },

    enqueueSave() {
      let data: string;
      try {
        data = serializeState(service, store, tokenMap);
      } catch (error) {
        recordError(error);
        return;
      }

      pendingSave = pendingSave.then(() => adapter.save(data)).catch(recordError);
    },

    async flush() {
      let currentSave: Promise<void>;
      do {
        currentSave = pendingSave;
        await currentSave;
      } while (currentSave !== pendingSave);

      if (hasError) throw firstError;
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import { createEmulator, type Emulator, type PersistenceAdapter } from "../api.js";

async function createRepo(emulator: Emulator, name: string): Promise<Response> {
  return fetch(`${emulator.url}/user/repos`, {
    method: "POST",
    headers: {
      Authorization: "token test_token_admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, private: false }),
  });
}

async function listRepos(
  emulator: Emulator,
  token = "test_token_admin",
): Promise<Array<{ name: string; description: string | null }>> {
  const response = await fetch(`${emulator.url}/user/repos`, {
    headers: { Authorization: `token ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Array<{ name: string; description: string | null }>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("createEmulator persistence", () => {
  it("restores mutations after close and a new emulator start", async () => {
    let state: string | null = null;
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => state),
      save: vi.fn(async (data) => {
        state = data;
      }),
    };

    const first = await createEmulator({ service: "github", port: 14040, persistence });
    expect((await createRepo(first, "persisted-repo")).status).toBe(201);
    const update = await fetch(`${first.url}/repos/admin/persisted-repo`, {
      method: "PATCH",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "persisted update" }),
    });
    expect(update.status).toBe(200);
    await first.close();

    const second = await createEmulator({
      service: "github",
      port: 14041,
      seed: { github: { users: [{ login: "ignored-seed-user" }] } },
      persistence,
    });
    expect(await listRepos(second)).toContainEqual(
      expect.objectContaining({ name: "persisted-repo", description: "persisted update" }),
    );
    await second.close();
  });

  it("restores token state and skips seed data when a snapshot exists", async () => {
    let state: string | null = null;
    const save = vi.fn(async (data: string) => {
      state = data;
    });
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => state),
      save,
    };

    const first = await createEmulator({
      service: "github",
      port: 14050,
      seed: {
        tokens: { persisted_token: { login: "persisted-user", scopes: ["repo"] } },
        github: { users: [{ login: "persisted-user" }] },
      },
      persistence,
    });
    await first.close();

    const second = await createEmulator({
      service: "github",
      port: 14051,
      seed: {
        tokens: { ignored_token: { login: "ignored-user", scopes: ["repo"] } },
        github: { users: [{ login: "ignored-user" }] },
      },
      persistence,
    });
    const persistedUser = await fetch(`${second.url}/user`, {
      headers: { Authorization: "token persisted_token" },
    });
    expect(persistedUser.status).toBe(200);
    expect(await persistedUser.json()).toMatchObject({ login: "persisted-user" });

    const ignoredSeedUser = await fetch(`${second.url}/users/ignored-user`);
    expect(ignoredSeedUser.status).toBe(404);
    await second.close();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("persists reset state", async () => {
    let state: string | null = null;
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => state),
      save: vi.fn(async (data) => {
        state = data;
      }),
    };

    const first = await createEmulator({ service: "github", port: 14060, persistence });
    expect((await createRepo(first, "removed-by-reset")).status).toBe(201);
    first.reset();
    await first.close();

    const second = await createEmulator({ service: "github", port: 14061, persistence });
    expect(await listRepos(second)).toHaveLength(0);
    await second.close();
  });

  it("captures and writes mutation snapshots serially", async () => {
    const savedStates: string[] = [];
    const releases: Array<() => void> = [];
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => null),
      save: vi.fn(
        (data) =>
          new Promise<void>((resolve) => {
            savedStates.push(data);
            activeSaves++;
            maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
            releases.push(() => {
              activeSaves--;
              resolve();
            });
          }),
      ),
    };

    const emulator = await createEmulator({ service: "github", port: 14070, persistence });
    await vi.waitFor(() => expect(savedStates).toHaveLength(1));

    expect((await createRepo(emulator, "first-repo")).status).toBe(201);
    expect((await createRepo(emulator, "second-repo")).status).toBe(201);
    expect(savedStates).toHaveLength(1);

    const closePromise = emulator.close();
    releases.shift()!();
    await vi.waitFor(() => expect(savedStates).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(savedStates).toHaveLength(3));
    releases.shift()!();
    await closePromise;

    const repoCounts = savedStates.map((raw) => {
      const state = JSON.parse(raw) as {
        store: { collections: Record<string, { items: unknown[] }> };
      };
      return state.store.collections["github.repos"].items.length;
    });
    expect(repoCounts).toEqual([0, 1, 2]);
    expect(maxActiveSaves).toBe(1);
  });

  it("waits for pending persistence before close resolves", async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {
        saveStarted.resolve();
        await releaseSave.promise;
      }),
    };
    const emulator = await createEmulator({ service: "github", port: 14080, persistence });
    await saveStarted.promise;

    let closed = false;
    const closePromise = emulator.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseSave.resolve();
    await closePromise;
    expect(closed).toBe(true);
  });

  it.each([
    ["malformed JSON", "{", "expected valid JSON"],
    ["an incompatible version", JSON.stringify({ version: 2 }), "expected version 1"],
    [
      "a malformed envelope",
      JSON.stringify({ version: 1, service: "github", store: {}, tokens: [] }),
      "malformed store or token data",
    ],
    [
      "a snapshot for another service",
      JSON.stringify({
        version: 1,
        service: "slack",
        store: { collections: {}, data: {} },
        tokens: [],
      }),
      "expected service github",
    ],
  ])("fails closed when persistence contains %s", async (_label, state, expectedMessage) => {
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => state),
      save: vi.fn(),
    };

    await expect(createEmulator({ service: "github", port: 14090, persistence })).rejects.toThrow(expectedMessage);
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it("surfaces persistence save failures from close", async () => {
    const saveError = new Error("persistence unavailable");
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {
        throw saveError;
      }),
    };

    const emulator = await createEmulator({ service: "github", port: 14100, persistence });
    await expect(emulator.close()).rejects.toBe(saveError);
  });

  it("does not persist unsuccessful mutating requests", async () => {
    const persistence: PersistenceAdapter = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
    };
    const emulator = await createEmulator({ service: "github", port: 14110, persistence });

    const response = await fetch(`${emulator.url}/does-not-exist`, { method: "POST" });
    expect(response.status).toBe(404);
    await emulator.close();

    expect(persistence.save).toHaveBeenCalledTimes(1);
  });
});

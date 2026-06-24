import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmulator, filePersistence, type Emulator, type PersistenceAdapter } from "../api.js";

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
  it("round-trips through atomic file persistence without leftover temporary state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-api-persistence-"));
    const path = join(directory, "github.json");
    const persistence = filePersistence(path);
    let first: Emulator | undefined;
    let second: Emulator | undefined;

    try {
      first = await createEmulator({ service: "github", port: 14039, persistence });
      expect((await createRepo(first, "atomic-file-repo")).status).toBe(201);
      await first.close();
      first = undefined;

      const state = JSON.parse(await readFile(path, "utf-8")) as { version: number; service: string };
      expect(state).toMatchObject({ version: 1, service: "github" });
      expect(await readdir(directory)).toEqual(["github.json"]);

      second = await createEmulator({ service: "github", port: 14038, persistence });
      expect(await listRepos(second)).toContainEqual(expect.objectContaining({ name: "atomic-file-repo" }));
      await second.close();
      second = undefined;

      expect(await readdir(directory)).toEqual(["github.json"]);
    } finally {
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drains terminal service side effects before its final persisted snapshot", async () => {
    let state: string | null = null;
    const persistence: PersistenceAdapter = {
      async load() {
        return state;
      },
      async save(data) {
        state = data;
      },
    };
    const target = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        setTimeout(() => {
          if (body.includes("delayed transport")) {
            request.socket.destroy();
          } else {
            response.writeHead(200, { "Content-Type": "text/plain" });
            response.end("accepted");
          }
        }, 75);
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP target port");
    let first: Emulator | undefined;
    let restored: Emulator | undefined;

    try {
      first = await createEmulator({
        service: "github",
        port: 14037,
        persistence,
        seed: {
          github: {
            users: [{ login: "octocat" }],
            repos: [{ owner: "octocat", name: "hello-world" }],
            apps: [
              {
                app_id: 100,
                slug: "persistence-app",
                name: "Persistence App",
                private_key: "issue-96-test-key",
                events: ["issues"],
                webhook_url: `http://127.0.0.1:${address.port}/github`,
                installations: [
                  {
                    installation_id: 42,
                    account: "octocat",
                    repository_selection: "all",
                  },
                ],
              },
            ],
          },
        },
      });

      for (const title of ["delayed success", "delayed transport"]) {
        const response = await fetch(`${first.url}/repos/octocat/hello-world/issues`, {
          method: "POST",
          headers: {
            Authorization: "token test_token_admin",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        });
        expect(response.status).toBe(201);
      }

      await first.close();
      first = undefined;
      const persisted = JSON.parse(state!) as {
        store: { collections: Record<string, { items: Array<{ status: string; status_code: number | null }> }> };
      };
      expect(persisted.store.collections["github.app_webhook_attempts"]!.items).toMatchObject([
        { status: "OK", status_code: 200 },
        { status: "Unavailable", status_code: null },
      ]);

      restored = await createEmulator({ service: "github", port: 14036, persistence });
      await restored.close();
      restored = undefined;
      const afterRestore = JSON.parse(state!) as {
        store: { collections: Record<string, { items: Array<{ status: string; status_code: number | null }> }> };
      };
      expect(afterRestore.store.collections["github.app_webhook_attempts"]!.items).not.toContainEqual(
        expect.objectContaining({ status: "Pending" }),
      );
    } finally {
      await first?.close().catch(() => undefined);
      await restored?.close().catch(() => undefined);
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

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

    expect(save).toHaveBeenCalledTimes(3);
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
    await vi.waitFor(() => expect(savedStates).toHaveLength(4));
    releases.shift()!();
    await closePromise;

    const repoCounts = savedStates.map((raw) => {
      const state = JSON.parse(raw) as {
        store: { collections: Record<string, { items: unknown[] }> };
      };
      return state.store.collections["github.repos"].items.length;
    });
    expect(repoCounts).toEqual([0, 1, 2, 2]);
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

    expect(persistence.save).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Collection, Store, type Entity, serializeValue, deserializeValue } from "../store.js";
import { filePersistence } from "../persistence.js";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<typeof import("node:fs/promises").readFile>(),
  rename: vi.fn<typeof import("node:fs/promises").rename>(),
  rm: vi.fn<typeof import("node:fs/promises").rm>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.readFile.mockImplementation(actual.readFile);
  fsMocks.rename.mockImplementation(actual.rename);
  fsMocks.rm.mockImplementation(actual.rm);
  return { ...actual, readFile: fsMocks.readFile, rename: fsMocks.rename, rm: fsMocks.rm };
});

interface User extends Entity {
  login: string;
  email?: string;
}

interface Repo extends Entity {
  name: string;
  owner_id: number;
}

describe("serializeValue / deserializeValue", () => {
  it("round-trips a Map", () => {
    const original = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const serialized = serializeValue(original);
    expect(serialized).toEqual({
      __type: "Map",
      entries: [
        ["a", 1],
        ["b", 2],
      ],
    });
    const restored = deserializeValue(serialized);
    expect(restored).toBeInstanceOf(Map);
    expect(restored).toEqual(original);
  });

  it("round-trips a Set", () => {
    const original = new Set(["x", "y", "z"]);
    const serialized = serializeValue(original);
    expect(serialized).toEqual({ __type: "Set", values: ["x", "y", "z"] });
    const restored = deserializeValue(serialized);
    expect(restored).toBeInstanceOf(Set);
    expect(restored).toEqual(original);
  });

  it("round-trips nested Maps", () => {
    const inner = new Map([["code", "abc123"]]);
    const outer = new Map<string, unknown>([["pending", inner]]);
    const serialized = serializeValue(outer);
    const restored = deserializeValue(serialized) as Map<string, unknown>;
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get("pending")).toBeInstanceOf(Map);
    expect((restored.get("pending") as Map<string, string>).get("code")).toBe("abc123");
  });

  it("passes through primitives and plain objects", () => {
    expect(serializeValue("hello")).toBe("hello");
    expect(serializeValue(42)).toBe(42);
    expect(serializeValue(null)).toBe(null);
    const obj = { a: 1 };
    expect(serializeValue(obj)).toBe(obj);
    expect(deserializeValue(obj)).toBe(obj);
  });
});

describe("Collection snapshot/restore", () => {
  it("round-trips items and autoId", () => {
    const col = new Collection<User>(["login"]);
    col.insert({ login: "alice", email: "alice@test.com" });
    col.insert({ login: "bob" });

    const snap = col.snapshot();
    expect(snap.items).toHaveLength(2);
    expect(snap.autoId).toBe(3);
    expect(snap.indexFields).toEqual(["login"]);

    const col2 = new Collection<User>(["login"]);
    col2.restore(snap);
    expect(col2.all()).toHaveLength(2);
    expect(col2.findOneBy("login", "alice")?.email).toBe("alice@test.com");
    expect(col2.insert({ login: "charlie" }).id).toBe(3);
  });

  it("restores indexes correctly", () => {
    const col = new Collection<User>(["login"]);
    col.insert({ login: "alice" });
    col.insert({ login: "bob" });

    const snap = col.snapshot();
    const col2 = new Collection<User>(["login"]);
    col2.restore(snap);

    expect(col2.findBy("login", "alice")).toHaveLength(1);
    expect(col2.findBy("login", "bob")).toHaveLength(1);
    expect(col2.findBy("login", "nonexistent")).toHaveLength(0);
  });

  it("clear before restore removes old data", () => {
    const col = new Collection<User>(["login"]);
    col.insert({ login: "old" });

    const snap = {
      items: [{ id: 10, login: "new", created_at: "2025-01-01", updated_at: "2025-01-01" } as User],
      autoId: 11,
      indexFields: ["login"],
    };
    col.restore(snap);

    expect(col.all()).toHaveLength(1);
    expect(col.findOneBy("login", "old")).toBeUndefined();
    expect(col.findOneBy("login", "new")?.id).toBe(10);
  });
});

describe("Store snapshot/restore", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it("round-trips collections and data", () => {
    const users = store.collection<User>("users", ["login"]);
    const repos = store.collection<Repo>("repos", ["owner_id"]);

    users.insert({ login: "octocat", email: "octocat@github.com" });
    repos.insert({ name: "hello-world", owner_id: 1 });

    const pendingCodes = new Map([["code1", { login: "octocat", scope: "repo" }]]);
    store.setData("github.oauth.pendingCodes", pendingCodes);
    store.setData("slack.signing_secret", "s-secret-123");

    const snap = store.snapshot();
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json) as typeof snap;

    const store2 = new Store();
    store2.restore(parsed);

    const users2 = store2.collection<User>("users", ["login"]);
    expect(users2.all()).toHaveLength(1);
    expect(users2.findOneBy("login", "octocat")?.email).toBe("octocat@github.com");

    const repos2 = store2.collection<Repo>("repos", ["owner_id"]);
    expect(repos2.all()).toHaveLength(1);
    expect(repos2.findBy("owner_id", 1)).toHaveLength(1);

    const restoredCodes = store2.getData<Map<string, { login: string; scope: string }>>("github.oauth.pendingCodes");
    expect(restoredCodes).toBeInstanceOf(Map);
    expect(restoredCodes?.get("code1")?.login).toBe("octocat");

    expect(store2.getData<string>("slack.signing_secret")).toBe("s-secret-123");
  });

  it("handles empty store", () => {
    const snap = store.snapshot();
    expect(Object.keys(snap.collections)).toHaveLength(0);
    expect(Object.keys(snap.data)).toHaveLength(0);

    const store2 = new Store();
    store2.restore(snap);
    expect(store2.getData("anything")).toBeUndefined();
  });

  it("restore merges into existing collections", () => {
    const users = store.collection<User>("users", ["login"]);
    users.insert({ login: "existing" });

    const snap = store.snapshot();

    const store2 = new Store();
    store2.collection<User>("users", ["login"]).insert({ login: "will-be-replaced" });
    store2.restore(snap);

    const users2 = store2.collection<User>("users", ["login"]);
    expect(users2.all()).toHaveLength(1);
    expect(users2.findOneBy("login", "existing")).toBeDefined();
    expect(users2.findOneBy("login", "will-be-replaced")).toBeUndefined();
  });

  it("restore removes collections not present in the snapshot", () => {
    store.collection<User>("users", ["login"]).insert({ login: "alice" });
    store.collection<Repo>("repos", ["owner_id"]).insert({ name: "hello-world", owner_id: 1 });

    const usersOnly = new Store();
    usersOnly.collection<User>("users", ["login"]).insert({ login: "bob" });
    const snap = usersOnly.snapshot();

    store.restore(snap);

    const users = store.collection<User>("users", ["login"]);
    expect(users.all()).toHaveLength(1);
    expect(users.findOneBy("login", "bob")).toBeDefined();

    const repos = store.collection<Repo>("repos", ["owner_id"]);
    expect(repos.all()).toHaveLength(0);
  });

  it("survives JSON round-trip with Sets in data", () => {
    const tracker = new Set(["user1@test.com", "user2@test.com"]);
    store.setData("apple.oauth.firstAuthTracker", tracker);

    const json = JSON.stringify(store.snapshot());
    const store2 = new Store();
    store2.restore(JSON.parse(json));

    const restored = store2.getData<Set<string>>("apple.oauth.firstAuthTracker");
    expect(restored).toBeInstanceOf(Set);
    expect(restored?.has("user1@test.com")).toBe(true);
    expect(restored?.size).toBe(2);
  });
});

describe("filePersistence", () => {
  let directory: string;
  let tmpPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emulate-persistence-"));
    tmpPath = join(directory, "state.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("save writes and load reads a JSON file", async () => {
    const adapter = filePersistence(tmpPath);
    const data = JSON.stringify({ test: true });

    await adapter.save(data);
    expect(existsSync(tmpPath)).toBe(true);
    expect(readFileSync(tmpPath, "utf-8")).toBe(data);

    const loaded = await adapter.load();
    expect(loaded).toBe(data);
  });

  it("load returns null for nonexistent file", async () => {
    const adapter = filePersistence(tmpPath);
    expect(await adapter.load()).toBeNull();
  });

  it("load propagates errors other than ENOENT", async () => {
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    fsMocks.readFile.mockRejectedValueOnce(permissionError);
    const adapter = filePersistence(tmpPath);

    await expect(adapter.load()).rejects.toBe(permissionError);
  });

  it("atomically replaces an existing file", async () => {
    writeFileSync(tmpPath, "old");
    const adapter = filePersistence(tmpPath);

    await adapter.save("new");

    expect(readFileSync(tmpPath, "utf-8")).toBe("new");
    expect(fsMocks.rename).toHaveBeenCalledOnce();
    const [temporaryPath, targetPath] = fsMocks.rename.mock.calls[0];
    expect(temporaryPath).not.toBe(tmpPath);
    expect(targetPath).toBe(tmpPath);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("preserves the previous file and removes temporary state when replacement fails", async () => {
    writeFileSync(tmpPath, "old");
    const replacementError = Object.assign(new Error("replacement failed"), { code: "EIO" });
    fsMocks.rename.mockRejectedValueOnce(replacementError);
    const adapter = filePersistence(tmpPath);

    await expect(adapter.save("new")).rejects.toBe(replacementError);

    expect(readFileSync(tmpPath, "utf-8")).toBe("old");
    expect(readdirSync(directory)).toEqual(["state.json"]);
    expect(fsMocks.rm).toHaveBeenCalledOnce();
  });

  it("does not hide the replacement error when temporary cleanup also fails", async () => {
    writeFileSync(tmpPath, "old");
    const replacementError = new Error("replacement failed");
    fsMocks.rename.mockRejectedValueOnce(replacementError);
    fsMocks.rm.mockRejectedValueOnce(new Error("cleanup failed"));
    const adapter = filePersistence(tmpPath);

    await expect(adapter.save("new")).rejects.toBe(replacementError);
    expect(readFileSync(tmpPath, "utf-8")).toBe("old");
  });

  it("uses an isolated temporary file for each concurrent save", async () => {
    const adapter = filePersistence(tmpPath);

    await Promise.all([adapter.save("first"), adapter.save("second")]);

    expect(fsMocks.rename).toHaveBeenCalledTimes(2);
    const temporaryPaths = fsMocks.rename.mock.calls.map(([temporaryPath]) => temporaryPath);
    expect(new Set(temporaryPaths).size).toBe(2);
    expect(
      temporaryPaths.every((temporaryPath) => typeof temporaryPath === "string" && temporaryPath.startsWith(directory)),
    ).toBe(true);
    expect(["first", "second"]).toContain(readFileSync(tmpPath, "utf-8"));
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("save creates parent directories", async () => {
    const nested = join(directory, "deep", "state.json");
    const adapter = filePersistence(nested);
    await adapter.save("{}");
    expect(existsSync(nested)).toBe(true);
  });
});

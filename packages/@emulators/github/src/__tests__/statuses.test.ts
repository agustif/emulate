import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  Hono,
  Store,
  type TokenMap,
  WebhookDispatcher,
} from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const jsonHeaders = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "repo:status"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "other-repo" },
      { owner: "octocat", name: "private-repo", private: true },
    ],
  });

  return { app, store, webhooks };
}

async function createStatus(
  app: Hono,
  sha: string,
  body: Record<string, unknown>,
  repo = "hello-world",
): Promise<Response> {
  return app.request(`${base}/repos/octocat/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

describe("GitHub commit status routes", () => {
  let app: Hono;
  let store: Store;
  let webhooks: WebhookDispatcher;

  beforeEach(() => {
    ({ app, store, webhooks } = createTestApp());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a status and returns its GitHub wire fields", async () => {
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const sha = gh.branches.findBy("repo_id", repo.id).find((branch) => branch.name === "main")!.sha;

    const response = await createStatus(app, sha, {
      state: "pending",
      description: "CI is running",
      target_url: "https://ci.example/runs/1",
      context: "arcus/build",
    });

    expect(response.status).toBe(201);
    const status = (await response.json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      state: "pending",
      description: "CI is running",
      target_url: "https://ci.example/runs/1",
      context: "arcus/build",
      url: `${base}/repos/octocat/hello-world/statuses/${sha}`,
    });
    expect(status.id).toEqual(expect.any(Number));
    expect(status.node_id).toEqual(expect.any(String));
    expect(status.creator).toMatchObject({ login: "octocat" });
    expect(status.created_at).toEqual(expect.any(String));
  });

  it("uses defaults and validates state and optional field limits", async () => {
    const sha = "1".repeat(40);
    const created = await createStatus(app, sha, { state: "success" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      state: "success",
      context: "default",
      description: null,
      target_url: null,
    });

    expect((await createStatus(app, sha, { state: "cancelled" })).status).toBe(422);
    expect((await createStatus(app, sha, { state: "success", context: "" })).status).toBe(422);
    expect((await createStatus(app, sha, { state: "success", description: "x".repeat(141) })).status).toBe(422);
  });

  it("requires authentication to create but permits anonymous reads of public repositories", async () => {
    const sha = "2".repeat(40);
    const unauthorized = await app.request(`${base}/repos/octocat/hello-world/statuses/${sha}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "pending" }),
    });
    expect(unauthorized.status).toBe(401);

    expect((await createStatus(app, sha, { state: "pending" })).status).toBe(201);
    const publicRead = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/statuses`);
    expect(publicRead.status).toBe(200);

    const privateRead = await app.request(`${base}/repos/octocat/private-repo/commits/main/statuses`);
    expect(privateRead.status).toBe(401);
  });

  it("returns status history newest first with pagination and legacy-route parity", async () => {
    const sha = "3".repeat(40);
    await createStatus(app, sha, { state: "pending", context: "arcus/build" });
    await createStatus(app, sha, { state: "success", context: "arcus/build" });
    await createStatus(app, sha, { state: "success", context: "arcus/lint" });

    const first = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/statuses?per_page=2&page=1`);
    expect(first.status).toBe(200);
    expect(first.headers.get("Link")).toContain('rel="next"');
    expect(await first.json()).toMatchObject([
      { context: "arcus/lint", state: "success" },
      { context: "arcus/build", state: "success" },
    ]);

    const second = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/statuses?per_page=2&page=2`);
    expect(await second.json()).toMatchObject([{ context: "arcus/build", state: "pending" }]);

    const legacy = await app.request(`${base}/repos/octocat/hello-world/statuses/${sha}`);
    expect(await legacy.json()).toHaveLength(3);
  });

  it("combines only the latest status per context using GitHub state precedence", async () => {
    const sha = "4".repeat(40);
    await createStatus(app, sha, { state: "failure", context: "arcus/build" });
    await createStatus(app, sha, { state: "success", context: "arcus/build" });
    await createStatus(app, sha, { state: "success", context: "arcus/lint" });

    const success = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/status`);
    expect(await success.json()).toMatchObject({
      state: "success",
      sha,
      total_count: 2,
      statuses: [
        { context: "arcus/lint", state: "success" },
        { context: "arcus/build", state: "success" },
      ],
    });

    await createStatus(app, sha, { state: "pending", context: "arcus/security" });
    const pending = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/status`);
    expect(await pending.json()).toMatchObject({ state: "pending", total_count: 3 });

    await createStatus(app, sha, { state: "error", context: "arcus/lint" });
    const failure = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/status`);
    expect(await failure.json()).toMatchObject({ state: "failure", total_count: 3 });
  });

  it("returns pending for a known commit with no statuses", async () => {
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const sha = gh.branches.findBy("repo_id", repo.id).find((branch) => branch.name === "main")!.sha;
    const response = await app.request(`${base}/repos/octocat/hello-world/commits/main/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "pending", sha, total_count: 0, statuses: [] });
  });

  it("resolves accepted exact SHAs without making never-seen refs exist", async () => {
    const sha = "5".repeat(40);
    expect((await createStatus(app, sha, { state: "success" })).status).toBe(201);
    expect((await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/statuses`)).status).toBe(200);
    expect((await app.request(`${base}/repos/octocat/hello-world/commits/${"6".repeat(40)}/statuses`)).status).toBe(
      404,
    );
    expect((await app.request(`${base}/repos/octocat/hello-world/commits/missing/status`)).status).toBe(404);
  });

  it("scopes statuses to their repository even when SHAs match", async () => {
    const sha = "7".repeat(40);
    await createStatus(app, sha, { state: "success", context: "first" });
    await createStatus(app, sha, { state: "failure", context: "second" }, "other-repo");

    const first = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/status`);
    expect(await first.json()).toMatchObject({ state: "success", total_count: 1 });
    const second = await app.request(`${base}/repos/octocat/other-repo/commits/${sha}/status`);
    expect(await second.json()).toMatchObject({ state: "failure", total_count: 1 });
  });

  it("dispatches a repository status webhook with status, branch, commit, and sender fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", mockFetch);
    webhooks.register({
      url: "https://hooks.example/statuses",
      events: ["status"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });

    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const sha = gh.branches.findBy("repo_id", repo.id).find((branch) => branch.name === "main")!.sha;
    const response = await createStatus(app, sha, { state: "success", context: "arcus/build" });
    expect(response.status).toBe(201);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [, init] = mockFetch.mock.calls[0]!;
    expect(new Headers(init.headers).get("X-GitHub-Event")).toBe("status");
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      sha,
      state: "success",
      context: "arcus/build",
      name: "arcus/build",
      repository: { full_name: "octocat/hello-world" },
      sender: { login: "octocat" },
      commit: { sha },
      branches: [{ name: "main", commit: { sha } }],
    });
  });
});

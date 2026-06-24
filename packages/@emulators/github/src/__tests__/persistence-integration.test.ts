import { afterEach, describe, expect, it, vi } from "vitest";
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

const baseUrl = "http://localhost:4000";
const headers = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

async function waitForCompletedAppAttempt(store: Store): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    const attempts = getGitHubStore(store).appWebhookAttempts.all();
    if (attempts.length === 1 && attempts[0]!.status !== "Pending") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the GitHub App webhook attempt");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub status and App delivery persistence integration", () => {
  it("registers both route families and restores their shared Store collections", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("accepted", { status: 200 })));
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const tokenMap: TokenMap = new Map([["test-token", { login: "octocat", id: 1, scopes: ["repo", "repo:status"] }]]);
    const app = new Hono();
    app.onError(createApiErrorHandler());
    app.use("*", createErrorHandler());
    app.use("*", authMiddleware(tokenMap));
    githubPlugin.register(app as any, store, webhooks, baseUrl, tokenMap);
    githubPlugin.seed?.(store, baseUrl);
    seedFromConfig(store, baseUrl, {
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [
        {
          app_id: 100,
          slug: "integration-app",
          name: "Integration App",
          private_key: "issue-96-test-key",
          events: ["issues"],
          webhook_url: "https://hooks.example.test/github",
          installations: [
            {
              installation_id: 42,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
    });

    const sha = "a".repeat(40);
    const statusResponse = await app.request(`${baseUrl}/repos/octocat/hello-world/statuses/${sha}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "success", context: "integration/build" }),
    });
    expect(statusResponse.status).toBe(201);

    const issueResponse = await app.request(`${baseUrl}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Exercise App delivery persistence" }),
    });
    expect(issueResponse.status).toBe(201);
    await waitForCompletedAppAttempt(store);

    const serialized = JSON.stringify(store.snapshot());
    const restored = new Store();
    getGitHubStore(restored);
    restored.restore(JSON.parse(serialized));
    const gh = getGitHubStore(restored);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;

    expect(gh.commitStatuses.findBy("repo_id", repo.id)).toMatchObject([
      { sha, state: "success", context: "integration/build" },
    ]);
    expect(gh.appWebhookDeliveries.findBy("app_id", 100)).toMatchObject([
      { event: "issues", action: "opened", installation_id: 42, repository_id: repo.id },
    ]);
    const [delivery] = gh.appWebhookDeliveries.findBy("app_id", 100);
    expect(gh.appWebhookAttempts.findBy("delivery_id", delivery!.id)).toMatchObject([
      { app_id: 100, redelivery: false, status_code: 200 },
    ]);
  });
});

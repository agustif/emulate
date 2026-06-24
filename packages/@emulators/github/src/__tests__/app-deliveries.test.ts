import { createHmac } from "crypto";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const appHeaders = { "X-Test-App-ID": "100" };
const userHeaders = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

interface ReceivedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let target: Server;
let targetUrl: string;
let received: ReceivedRequest[];

beforeAll(async () => {
  received = [];
  target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ path: request.url ?? "/", headers: request.headers, body });
      if (request.url === "/drop") {
        request.socket.destroy();
        return;
      }
      const payload = JSON.parse(body) as { issue?: { title?: string } };
      if (payload.issue?.title?.includes("fail")) {
        response.writeHead(500, { "Content-Type": "text/plain", "X-Target": "failure" });
        response.end("failed");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain", "X-Target": "success" });
      response.end("accepted");
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address() as AddressInfo;
  targetUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  target.closeAllConnections();
  await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
});

function createTestApp(webhookPath = "/ok") {
  received.length = 0;
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  // Issue #96 blocks valid App JWT verification. This test-only middleware sets
  // the same authApp context produced by the existing authentication boundary.
  app.use("*", async (c, next) => {
    const appId = c.req.header("X-Test-App-ID");
    if (appId) c.set("authApp", { appId: Number(appId), slug: "delivery-app", name: "Delivery App" });
    await next();
  });
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
    apps: [
      {
        app_id: 100,
        slug: "delivery-app",
        name: "Delivery App",
        private_key: "issue-96-test-key",
        webhook_url: `${targetUrl}${webhookPath}`,
        webhook_secret: "delivery-secret",
        events: ["issues"],
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
  return { app, store };
}

async function createIssue(app: Hono, title: string): Promise<Response> {
  return app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ title }),
  });
}

async function waitForAttempts(store: Store, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const attempts = getGitHubStore(store).appWebhookAttempts.all();
    if (attempts.length >= count && attempts.every((item) => item.status !== "Pending")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} GitHub App webhook attempts`);
}

describe("GitHub App webhook delivery history", () => {
  it("records a successful delivery and exposes summary and full response shapes", async () => {
    const { app, store } = createTestApp();
    expect((await createIssue(app, "successful delivery")).status).toBe(201);
    await waitForAttempts(store, 1);
    expect(received).toHaveLength(1);

    const unauthorized = await app.request(`${base}/app/hook/deliveries`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(unauthorized.status).toBe(401);

    const list = await app.request(`${base}/app/hook/deliveries`, { headers: appHeaders });
    expect(list.status).toBe(200);
    const summaries = (await list.json()) as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      redelivery: false,
      status: "OK",
      status_code: 200,
      event: "issues",
      action: "opened",
      installation_id: 42,
      repository_id: expect.any(Number),
      throttled_at: null,
    });
    expect(summaries[0]).not.toHaveProperty("request");
    expect(summaries[0]).not.toHaveProperty("response");

    const id = summaries[0]!.id;
    const detailResponse = await app.request(`${base}/app/hook/deliveries/${id}`, { headers: appHeaders });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as any;
    expect(detail.request.payload).toMatchObject({
      action: "opened",
      issue: { title: "successful delivery" },
      installation: { id: 42 },
    });
    expect(detail.response).toMatchObject({
      headers: { "content-type": "text/plain", "x-target": "success" },
      payload: "accepted",
    });
    expect(detail.request.headers["X-GitHub-Delivery"]).toBe(detail.guid);
    expect(detail.request.headers["X-GitHub-Event"]).toBe("issues");
    expect(detail.request.headers).not.toHaveProperty("Authorization");
    expect(JSON.stringify(detail)).not.toContain("delivery-secret");

    const signature = createHmac("sha256", "delivery-secret").update(received[0]!.body).digest("hex");
    expect(detail.request.headers["X-Hub-Signature-256"]).toBe(`sha256=${signature}`);

    const snapshot = store.snapshot();
    const restored = new Store();
    getGitHubStore(restored);
    restored.restore(snapshot);
    const restoredGitHub = getGitHubStore(restored);
    expect(restoredGitHub.appWebhookDeliveries.all()).toHaveLength(1);
    expect(restoredGitHub.appWebhookAttempts.all()).toHaveLength(1);
    expect(restoredGitHub.appWebhookAttempts.all()[0]).toMatchObject({ status_code: 200, redelivery: false });
  });

  it("retains transport failures for inspection", async () => {
    const { app, store } = createTestApp("/drop");
    expect((await createIssue(app, "transport failure")).status).toBe(201);
    await waitForAttempts(store, 1);

    const list = await app.request(`${base}/app/hook/deliveries`, { headers: appHeaders });
    const [summary] = (await list.json()) as Array<Record<string, unknown>>;
    expect(summary).toMatchObject({ status: "Unavailable", status_code: null, redelivery: false });

    const detail = await app.request(`${base}/app/hook/deliveries/${summary!.id}`, { headers: appHeaders });
    expect(await detail.json()).toMatchObject({
      response: { headers: {}, payload: null },
      request: { payload: { issue: { title: "transport failure" } } },
    });
  });

  it("filters outcomes and paginates with stable delivery cursors", async () => {
    const { app, store } = createTestApp();
    await createIssue(app, "ok one");
    await createIssue(app, "fail one");
    await createIssue(app, "ok two");
    await waitForAttempts(store, 3);

    const successes = await app.request(`${base}/app/hook/deliveries?status=success`, { headers: appHeaders });
    expect(await successes.json()).toHaveLength(2);
    const failures = await app.request(`${base}/app/hook/deliveries?status=failure`, { headers: appHeaders });
    expect(await failures.json()).toMatchObject([{ status_code: 500 }]);

    const first = await app.request(`${base}/app/hook/deliveries?per_page=1`, { headers: appHeaders });
    const firstPage = (await first.json()) as Array<{ id: number }>;
    expect(firstPage).toHaveLength(1);
    const nextUrl = first.headers
      .get("Link")!
      .split(",")
      .find((link) => link.includes('rel="next"'))!
      .match(/<([^>]+)>/)![1]!;

    const second = await app.request(nextUrl, { headers: appHeaders });
    const secondPage = (await second.json()) as Array<{ id: number }>;
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]!.id).not.toBe(firstPage[0]!.id);
    expect(second.headers.get("Link")).toContain('rel="prev"');

    const invalid = await app.request(`${base}/app/hook/deliveries?cursor=missing`, { headers: appHeaders });
    expect(invalid.status).toBe(400);
  });

  it("redelivers the retained payload repeatedly with one stable GUID and new attempt IDs", async () => {
    const { app, store } = createTestApp();
    await createIssue(app, "redeliver me");
    await waitForAttempts(store, 1);
    const initial = await app.request(`${base}/app/hook/deliveries`, { headers: appHeaders });
    const [original] = (await initial.json()) as Array<{ id: number; guid: string }>;

    const firstRedelivery = await app.request(`${base}/app/hook/deliveries/${original!.id}/attempts`, {
      method: "POST",
      headers: appHeaders,
    });
    expect(firstRedelivery.status).toBe(202);

    const afterFirst = await app.request(`${base}/app/hook/deliveries`, { headers: appHeaders });
    const firstAttempts = (await afterFirst.json()) as Array<{ id: number; guid: string; redelivery: boolean }>;
    expect(firstAttempts).toHaveLength(2);
    expect(firstAttempts[0]).toMatchObject({ guid: original!.guid, redelivery: true });
    expect(firstAttempts[0]!.id).not.toBe(original!.id);

    const secondRedelivery = await app.request(`${base}/app/hook/deliveries/${firstAttempts[0]!.id}/attempts`, {
      method: "POST",
      headers: appHeaders,
    });
    expect(secondRedelivery.status).toBe(202);

    const final = await app.request(`${base}/app/hook/deliveries`, { headers: appHeaders });
    const attempts = (await final.json()) as Array<{ id: number; guid: string; redelivery: boolean }>;
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(3);
    expect(new Set(attempts.map((attempt) => attempt.guid))).toEqual(new Set([original!.guid]));
    expect(attempts.map((attempt) => attempt.redelivery)).toEqual([true, true, false]);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((request) => request.body)).size).toBe(1);
  });

  it("does not expose one App's deliveries to another App identity", async () => {
    const { app, store } = createTestApp();
    await createIssue(app, "scoped delivery");
    await waitForAttempts(store, 1);
    const list = await app.request(`${base}/app/hook/deliveries`, { headers: appHeaders });
    const [delivery] = (await list.json()) as Array<{ id: number }>;
    const otherAppHeaders = { "X-Test-App-ID": "200" };
    expect((await app.request(`${base}/app/hook/deliveries`, { headers: otherAppHeaders })).status).toBe(200);
    expect(await (await app.request(`${base}/app/hook/deliveries`, { headers: otherAppHeaders })).json()).toEqual([]);
    expect(
      (await app.request(`${base}/app/hook/deliveries/${delivery!.id}`, { headers: otherAppHeaders })).status,
    ).toBe(404);
  });
});

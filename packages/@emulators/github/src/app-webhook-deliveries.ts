import { createHmac, randomUUID } from "crypto";
import type {
  GitHubApp,
  GitHubAppInstallation,
  GitHubAppWebhookAttempt,
  GitHubAppWebhookDelivery,
} from "./entities.js";
import type { GitHubStore } from "./store.js";

function requestHeaders(
  app: GitHubApp,
  installation: GitHubAppInstallation,
  delivery: GitHubAppWebhookDelivery,
  body: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Content-Type": "application/json",
    "User-Agent": "GitHub-Hookshot/emulate",
    "X-GitHub-Delivery": delivery.guid,
    "X-GitHub-Event": delivery.event,
    "X-GitHub-Hook-ID": String(app.app_id),
    "X-GitHub-Hook-Installation-Target-ID": String(delivery.repository_id ?? installation.account_id),
    "X-GitHub-Hook-Installation-Target-Type": delivery.repository_id
      ? "repository"
      : installation.account_type.toLowerCase(),
  };
  if (app.webhook_secret) {
    const signature = createHmac("sha256", app.webhook_secret).update(body).digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${signature}`;
  }
  return headers;
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function performAttempt(
  gh: GitHubStore,
  app: GitHubApp,
  installation: GitHubAppInstallation,
  delivery: GitHubAppWebhookDelivery,
  redelivery: boolean,
): Promise<GitHubAppWebhookAttempt> {
  const body = JSON.stringify(delivery.payload);
  const headers = requestHeaders(app, installation, delivery, body);
  const deliveredAt = new Date().toISOString();
  const startedAt = Date.now();
  const attempt = gh.appWebhookAttempts.insert({
    app_id: app.app_id,
    delivery_id: delivery.id,
    redelivery,
    delivered_at: deliveredAt,
    duration: 0,
    status: "Pending",
    status_code: null,
    request_headers: headers,
    response_headers: {},
    response_payload: null,
  });
  let status = "Unavailable";
  let statusCode: number | null = null;
  let receivedHeaders: Record<string, string> = {};
  let responsePayload: string | null = null;

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
    statusCode = response.status;
    status = response.statusText || (response.status >= 200 && response.status < 400 ? "OK" : "Unknown");
    receivedHeaders = responseHeaders(response);
    try {
      responsePayload = await response.text();
    } catch {
      responsePayload = null;
    }
  } catch {
    // Transport failures are retained as failed attempts for inspection and redelivery.
  }

  gh.appWebhookAttempts.update(attempt.id, {
    duration: (Date.now() - startedAt) / 1000,
    status,
    status_code: statusCode,
    response_headers: receivedHeaders,
    response_payload: responsePayload,
  });
  return gh.appWebhookAttempts.get(attempt.id)!;
}

export async function createAppWebhookDelivery(
  gh: GitHubStore,
  app: GitHubApp,
  installation: GitHubAppInstallation,
  event: string,
  action: string | undefined,
  payload: unknown,
  repositoryId: number | null,
): Promise<GitHubAppWebhookAttempt> {
  if (!app.webhook_url) throw new Error("GitHub App webhook URL is not configured");
  const delivery = gh.appWebhookDeliveries.insert({
    app_id: app.app_id,
    guid: randomUUID(),
    event,
    action: action ?? null,
    installation_id: installation.installation_id,
    repository_id: repositoryId,
    url: app.webhook_url,
    payload,
  });
  return performAttempt(gh, app, installation, delivery, false);
}

export async function redeliverAppWebhook(
  gh: GitHubStore,
  app: GitHubApp,
  delivery: GitHubAppWebhookDelivery,
): Promise<GitHubAppWebhookAttempt> {
  const installation = gh.appInstallations
    .findBy("app_id", app.app_id)
    .find((candidate) => candidate.installation_id === delivery.installation_id);
  if (!installation) throw new Error("GitHub App installation no longer exists");
  return performAttempt(gh, app, installation, delivery, true);
}

export function formatAppWebhookDelivery(delivery: GitHubAppWebhookDelivery, attempt: GitHubAppWebhookAttempt) {
  return {
    id: attempt.id,
    guid: delivery.guid,
    delivered_at: attempt.delivered_at,
    redelivery: attempt.redelivery,
    duration: attempt.duration,
    status: attempt.status,
    status_code: attempt.status_code,
    event: delivery.event,
    action: delivery.action,
    installation_id: delivery.installation_id,
    repository_id: delivery.repository_id,
    throttled_at: null,
  };
}

export function formatAppWebhookDeliveryDetails(delivery: GitHubAppWebhookDelivery, attempt: GitHubAppWebhookAttempt) {
  return {
    ...formatAppWebhookDelivery(delivery, attempt),
    url: delivery.url,
    request: {
      headers: attempt.request_headers,
      payload: delivery.payload,
    },
    response: {
      headers: attempt.response_headers,
      payload: attempt.response_payload,
    },
  };
}

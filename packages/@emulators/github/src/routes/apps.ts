import { randomBytes } from "crypto";
import type { Context, RouteContext, AuthApp } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { generateNodeId } from "../helpers.js";
import {
  formatAppWebhookDelivery,
  formatAppWebhookDeliveryDetails,
  redeliverAppWebhook,
} from "../app-webhook-deliveries.js";

export function appsRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const gh = getGitHubStore(store);

  function requireApp(c: Context): AuthApp | null {
    const authApp = c.get("authApp") as AuthApp | undefined;
    if (!authApp) {
      c.status(401);
      return null;
    }
    return authApp;
  }

  function parseDeliveryId(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function deliveryAttemptForApp(appId: number, attemptId: number) {
    const attempt = gh.appWebhookAttempts.get(attemptId);
    if (!attempt || attempt.app_id !== appId) return null;
    const delivery = gh.appWebhookDeliveries.get(attempt.delivery_id);
    if (!delivery || delivery.app_id !== appId) return null;
    return { attempt, delivery };
  }

  function appDeliveryAttempts(appId: number) {
    return gh.appWebhookAttempts
      .findBy("app_id", appId)
      .sort((left, right) => right.id - left.id)
      .flatMap((attempt) => {
        const delivery = gh.appWebhookDeliveries.get(attempt.delivery_id);
        return delivery && delivery.app_id === appId ? [{ attempt, delivery }] : [];
      });
  }

  function setDeliveryLinkHeader(
    c: Context,
    items: ReturnType<typeof appDeliveryAttempts>,
    startIndex: number,
    pageSize: number,
  ): void {
    const links: string[] = [];
    const url = new URL(c.req.url);
    const pageItems = items.slice(startIndex, startIndex + pageSize);
    if (startIndex + pageSize < items.length && pageItems.length > 0) {
      url.searchParams.set("cursor", String(pageItems[pageItems.length - 1]!.attempt.id));
      links.push(`<${url.toString()}>; rel="next"`);
    }
    if (startIndex > 0) {
      const previousStart = Math.max(0, startIndex - pageSize);
      if (previousStart === 0) {
        url.searchParams.delete("cursor");
      } else {
        url.searchParams.set("cursor", String(items[previousStart - 1]!.attempt.id));
      }
      links.push(`<${url.toString()}>; rel="prev"`);
    }
    if (links.length > 0) c.header("Link", links.join(", "));
  }

  app.get("/app", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === authApp.appId);
    if (!ghApp) {
      return c.json({ message: "Not Found" }, 404);
    }

    const installations = gh.appInstallations.findBy("app_id", ghApp.app_id);

    return c.json({
      id: ghApp.app_id,
      slug: ghApp.slug,
      node_id: generateNodeId("App", ghApp.app_id),
      name: ghApp.name,
      description: ghApp.description,
      external_url: `${baseUrl}/apps/${ghApp.slug}`,
      html_url: `${baseUrl}/apps/${ghApp.slug}`,
      created_at: ghApp.created_at,
      updated_at: ghApp.updated_at,
      permissions: ghApp.permissions,
      events: ghApp.events,
      installations_count: installations.length,
      owner: null,
    });
  });

  app.get("/app/installations", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const installations = gh.appInstallations.findBy("app_id", authApp.appId);
    const ghApp = gh.apps.all().find((a) => a.app_id === authApp.appId);

    return c.json(installations.map((inst) => formatInstallation(inst, ghApp, baseUrl)));
  });

  app.get("/app/hook/deliveries", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const rawPerPage = c.req.query("per_page") ?? "30";
    const parsedPerPage = parseInt(rawPerPage, 10);
    const perPage = Number.isFinite(parsedPerPage) ? Math.min(100, Math.max(1, parsedPerPage)) : 30;
    const status = c.req.query("status");
    if (status !== undefined && status !== "success" && status !== "failure") {
      return c.json({ message: "Invalid status filter", documentation_url: "https://docs.github.com/rest" }, 422);
    }

    let items = appDeliveryAttempts(authApp.appId);
    if (status === "success") {
      items = items.filter(({ attempt }) =>
        attempt.status_code !== null ? attempt.status_code >= 200 && attempt.status_code <= 399 : false,
      );
    } else if (status === "failure") {
      items = items.filter(({ attempt }) =>
        attempt.status_code !== null ? attempt.status_code >= 400 && attempt.status_code <= 599 : false,
      );
    }

    let startIndex = 0;
    const cursor = c.req.query("cursor");
    if (cursor !== undefined) {
      const cursorId = parseDeliveryId(cursor);
      const cursorIndex = cursorId === null ? -1 : items.findIndex(({ attempt }) => attempt.id === cursorId);
      if (cursorIndex < 0) {
        return c.json({ message: "Invalid cursor", documentation_url: "https://docs.github.com/rest" }, 400);
      }
      startIndex = cursorIndex + 1;
    }

    setDeliveryLinkHeader(c, items, startIndex, perPage);
    return c.json(
      items
        .slice(startIndex, startIndex + perPage)
        .map(({ delivery, attempt }) => formatAppWebhookDelivery(delivery, attempt)),
    );
  });

  app.get("/app/hook/deliveries/:delivery_id", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }
    const deliveryId = parseDeliveryId(c.req.param("delivery_id"));
    if (deliveryId === null) {
      return c.json({ message: "Invalid delivery_id", documentation_url: "https://docs.github.com/rest" }, 400);
    }
    const pair = deliveryAttemptForApp(authApp.appId, deliveryId);
    if (!pair) return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    return c.json(formatAppWebhookDeliveryDetails(pair.delivery, pair.attempt));
  });

  app.post("/app/hook/deliveries/:delivery_id/attempts", async (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }
    const deliveryId = parseDeliveryId(c.req.param("delivery_id"));
    if (deliveryId === null) {
      return c.json({ message: "Invalid delivery_id", documentation_url: "https://docs.github.com/rest" }, 400);
    }
    const pair = deliveryAttemptForApp(authApp.appId, deliveryId);
    if (!pair) return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    const ghApp = gh.apps.all().find((candidate) => candidate.app_id === authApp.appId);
    if (!ghApp) return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    try {
      await redeliverAppWebhook(gh, ghApp, pair.delivery);
    } catch {
      return c.json(
        { message: "Delivery cannot be redelivered", documentation_url: "https://docs.github.com/rest" },
        422,
      );
    }
    return c.body(null, 202);
  });

  app.get("/app/installations/:installation_id", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const installationId = parseInt(c.req.param("installation_id"), 10);
    const inst = gh.appInstallations
      .all()
      .find((i) => i.installation_id === installationId && i.app_id === authApp.appId);

    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === authApp.appId);
    return c.json(formatInstallation(inst, ghApp, baseUrl));
  });

  app.post("/app/installations/:installation_id/access_tokens", async (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const installationId = parseInt(c.req.param("installation_id"), 10);
    const inst = gh.appInstallations
      .all()
      .find((i) => i.installation_id === installationId && i.app_id === authApp.appId);

    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    let requestedPermissions = inst.permissions;
    let requestedRepoIds = inst.repository_ids;

    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (body.permissions && typeof body.permissions === "object") {
        requestedPermissions = body.permissions as Record<string, string>;
      }
      if (Array.isArray(body.repository_ids)) {
        requestedRepoIds = (body.repository_ids as number[]).filter(
          (id) => inst.repository_selection === "all" || inst.repository_ids.includes(id),
        );
      }
    } catch {
      // No body or invalid JSON, use installation defaults
    }

    const token = "ghs_" + randomBytes(20).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    if (tokenMap) {
      tokenMap.set(token, {
        login: inst.account_login,
        id: inst.account_id,
        scopes: Object.entries(requestedPermissions).map(([k, v]) => `${k}:${v}`),
      });
    }

    const repos = requestedRepoIds
      .map((id) => gh.repos.get(id))
      .filter(Boolean)
      .map((r) => ({
        id: r!.id,
        node_id: r!.node_id,
        name: r!.name,
        full_name: r!.full_name,
        private: r!.private,
      }));

    return c.json(
      {
        token,
        expires_at: expiresAt,
        permissions: requestedPermissions,
        repository_selection: inst.repository_selection,
        ...(inst.repository_selection === "selected" ? { repositories: repos } : {}),
      },
      201,
    );
  });

  app.get("/repos/:owner/:repo/installation", (c) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const fullName = `${owner}/${repoName}`;
    const repo = gh.repos.findOneBy("full_name", fullName);
    if (!repo) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ownerEntity = gh.users.findOneBy("login", owner) ?? gh.orgs.findOneBy("login", owner);

    for (const inst of gh.appInstallations.all()) {
      if (inst.repository_selection === "all" && ownerEntity && inst.account_id === ownerEntity.id) {
        const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
        return c.json(formatInstallation(inst, ghApp, baseUrl));
      }
      if (inst.repository_selection === "selected" && inst.repository_ids.includes(repo.id)) {
        const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
        return c.json(formatInstallation(inst, ghApp, baseUrl));
      }
    }

    return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
  });

  app.get("/orgs/:org/installation", (c) => {
    const orgLogin = c.req.param("org");
    const org = gh.orgs.findOneBy("login", orgLogin);
    if (!org) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const inst = gh.appInstallations.all().find((i) => i.account_id === org.id && i.account_type === "Organization");
    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
    return c.json(formatInstallation(inst, ghApp, baseUrl));
  });

  app.get("/users/:username/installation", (c) => {
    const username = c.req.param("username");
    const user = gh.users.findOneBy("login", username);
    if (!user) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const inst = gh.appInstallations.all().find((i) => i.account_id === user.id && i.account_type === "User");
    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
    return c.json(formatInstallation(inst, ghApp, baseUrl));
  });

  function formatInstallation(inst: any, ghApp: any, baseUrl: string) {
    const account = inst.account_type === "Organization" ? gh.orgs.get(inst.account_id) : gh.users.get(inst.account_id);

    return {
      id: inst.installation_id,
      account: account
        ? {
            login: account.login,
            id: account.id,
            node_id: account.node_id,
            type: inst.account_type,
            avatar_url: `${baseUrl}/avatars/u/${account.login}`,
            url: `${baseUrl}/${inst.account_type === "Organization" ? "orgs" : "users"}/${account.login}`,
          }
        : null,
      repository_selection: inst.repository_selection,
      access_tokens_url: `${baseUrl}/app/installations/${inst.installation_id}/access_tokens`,
      repositories_url: `${baseUrl}/installation/repositories`,
      html_url: `${baseUrl}/settings/installations/${inst.installation_id}`,
      app_id: inst.app_id,
      app_slug: ghApp?.slug ?? null,
      target_type: inst.account_type,
      permissions: inst.permissions,
      events: inst.events,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: inst.suspended_at,
    };
  }
}

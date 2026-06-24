import type { Context, RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import type { GitHubCommit, GitHubCommitStatus, GitHubRepo, GitHubUser } from "../entities.js";
import { formatRepo, formatUser, generateNodeId, lookupRepo } from "../helpers.js";
import { assertRepoRead, assertRepoWrite, notFoundResponse, ownerLoginOf } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";

const STATUS_STATES = new Set<GitHubCommitStatus["state"]>(["error", "failure", "pending", "success"]);

function resolveRefToSha(gh: GitHubStore, repo: GitHubRepo, refParam: string): string | undefined {
  const ref = refParam;
  const normalized = ref.toLowerCase();
  const commit = gh.commits
    .findBy("repo_id", repo.id)
    .find(
      (candidate) => candidate.sha.toLowerCase() === normalized || candidate.sha.toLowerCase().startsWith(normalized),
    );
  if (commit) return commit.sha;

  const branch = gh.branches.findBy("repo_id", repo.id).find((candidate) => candidate.name === ref);
  if (branch) return branch.sha;

  const refs = ref.startsWith("refs/") ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  const storedRef = gh.refs.findBy("repo_id", repo.id).find((candidate) => refs.includes(candidate.ref));
  if (storedRef) return storedRef.sha;

  // Creating a status establishes that its exact SHA is known to this API, just as
  // creating a check run establishes its head SHA for subsequent Checks reads.
  const status = gh.commitStatuses.findBy("repo_id", repo.id).find((candidate) => candidate.sha === ref);
  return status?.sha;
}

function statusesForSha(gh: GitHubStore, repo: GitHubRepo, sha: string): GitHubCommitStatus[] {
  return gh.commitStatuses
    .findBy("repo_id", repo.id)
    .filter((status) => status.sha === sha)
    .sort((left, right) => right.id - left.id);
}

function latestByContext(statuses: GitHubCommitStatus[]): GitHubCommitStatus[] {
  const contexts = new Set<string>();
  const latest: GitHubCommitStatus[] = [];
  for (const status of statuses) {
    if (contexts.has(status.context)) continue;
    contexts.add(status.context);
    latest.push(status);
  }
  return latest;
}

function combinedState(statuses: GitHubCommitStatus[]): "failure" | "pending" | "success" {
  if (statuses.some((status) => status.state === "error" || status.state === "failure")) return "failure";
  if (statuses.length === 0 || statuses.some((status) => status.state === "pending")) return "pending";
  return "success";
}

function formatStatus(status: GitHubCommitStatus, gh: GitHubStore, repo: GitHubRepo, baseUrl: string) {
  const creator = gh.users.get(status.creator_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    url: `${repoUrl}/statuses/${status.sha}`,
    avatar_url: creator ? formatUser(creator, baseUrl).avatar_url : null,
    id: status.id,
    node_id: status.node_id,
    state: status.state,
    description: status.description,
    target_url: status.target_url,
    context: status.context,
    created_at: status.created_at,
    updated_at: status.updated_at,
    creator: creator ? formatUser(creator, baseUrl) : null,
  };
}

function formatWebhookCommit(commit: GitHubCommit | undefined, sha: string, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  if (!commit) {
    return {
      id: sha,
      sha,
      url: `${repoUrl}/commits/${sha}`,
      html_url: `${baseUrl}/${repo.full_name}/commit/${sha}`,
    };
  }
  return {
    id: commit.sha,
    sha: commit.sha,
    node_id: commit.node_id,
    message: commit.message,
    url: `${repoUrl}/commits/${commit.sha}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${commit.sha}`,
    author: {
      name: commit.author_name,
      email: commit.author_email,
      date: commit.author_date,
    },
    committer: {
      name: commit.committer_name,
      email: commit.committer_email,
      date: commit.committer_date,
    },
  };
}

function parseOptionalString(body: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) throw new ApiError(422, `Invalid ${key}`);
  return value;
}

function parseContext(body: Record<string, unknown>): string {
  const value = body.context ?? "default";
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new ApiError(422, "Invalid context");
  return value;
}

function parseState(value: unknown): GitHubCommitStatus["state"] {
  if (typeof value !== "string" || !STATUS_STATES.has(value as GitHubCommitStatus["state"])) {
    throw new ApiError(422, "Invalid state");
  }
  return value as GitHubCommitStatus["state"];
}

function findCommit(gh: GitHubStore, repo: GitHubRepo, sha: string): GitHubCommit | undefined {
  return gh.commits.findBy("repo_id", repo.id).find((commit) => commit.sha === sha);
}

function webhookPayload(
  status: GitHubCommitStatus,
  actor: GitHubUser,
  gh: GitHubStore,
  repo: GitHubRepo,
  baseUrl: string,
) {
  const formatted = formatStatus(status, gh, repo, baseUrl);
  const branches = gh.branches
    .findBy("repo_id", repo.id)
    .filter((branch) => branch.sha === status.sha)
    .slice(0, 10)
    .map((branch) => ({
      name: branch.name,
      commit: {
        sha: branch.sha,
        url: `${baseUrl}/repos/${repo.full_name}/commits/${branch.sha}`,
      },
      protected: branch.protected,
    }));
  return {
    ...formatted,
    sha: status.sha,
    name: status.context,
    branches,
    commit: formatWebhookCommit(findCommit(gh, repo, status.sha), status.sha, repo, baseUrl),
    repository: formatRepo(repo, gh, baseUrl, actor.id),
    sender: formatUser(actor, baseUrl),
  };
}

export function statusesRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.post("/repos/:owner/:repo/statuses/:sha", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const sha = c.req.param("sha")!.trim();
    if (!sha) throw new ApiError(422, "Invalid sha");

    const body = await parseJsonBody(c);
    const state = parseState(body.state);
    const context = parseContext(body);
    const description = parseOptionalString(body, "description", 140);
    const targetUrl = parseOptionalString(body, "target_url", 1024);

    const count = statusesForSha(gh, repo, sha).filter((status) => status.context === context).length;
    if (count >= 1000) throw new ApiError(422, "Maximum number of statuses reached for this SHA and context");

    const inserted = gh.commitStatuses.insert({
      node_id: "",
      repo_id: repo.id,
      sha,
      state,
      description,
      target_url: targetUrl,
      context,
      creator_id: actor.id,
    } as Omit<GitHubCommitStatus, "id" | "created_at" | "updated_at">);
    gh.commitStatuses.update(inserted.id, { node_id: generateNodeId("Status", inserted.id) });
    const status = gh.commitStatuses.get(inserted.id)!;

    await webhooks.dispatch(
      "status",
      undefined,
      webhookPayload(status, actor, gh, repo, baseUrl),
      ownerLoginOf(gh, repo),
      repo.name,
    );
    return c.json(formatStatus(status, gh, repo, baseUrl), 201);
  });

  const listStatuses = async (c: Context) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const ref = c.req.param("ref")!;
    const sha = resolveRefToSha(gh, repo, ref);
    if (!sha) throw notFoundResponse();

    const all = statusesForSha(gh, repo, sha);
    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, all.length, page, per_page);
    const pageItems = all.slice((page - 1) * per_page, page * per_page);
    return c.json(pageItems.map((status) => formatStatus(status, gh, repo, baseUrl)));
  };

  app.get("/repos/:owner/:repo/commits/:ref{.+}/statuses", listStatuses);
  app.get("/repos/:owner/:repo/statuses/:ref{.+}", listStatuses);

  app.get("/repos/:owner/:repo/commits/:ref{.+}/status", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const ref = c.req.param("ref")!;
    const sha = resolveRefToSha(gh, repo, ref);
    if (!sha) throw notFoundResponse();

    const latest = latestByContext(statusesForSha(gh, repo, sha));
    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, latest.length, page, per_page);
    const pageItems = latest.slice((page - 1) * per_page, page * per_page);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json({
      state: combinedState(latest),
      statuses: pageItems.map((status) => formatStatus(status, gh, repo, baseUrl)),
      sha,
      total_count: latest.length,
      repository: formatRepo(repo, gh, baseUrl),
      commit_url: `${repoUrl}/commits/${sha}`,
      url: `${repoUrl}/commits/${sha}/status`,
    });
  });
}

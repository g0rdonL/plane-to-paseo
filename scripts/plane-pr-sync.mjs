#!/usr/bin/env node
/**
 * GitHub pull requests ⇄ Plane work items. Dependency-free (Node 22+), so the same file can be
 * copied into any repo that tracks work in a Plane project.
 *
 * GitHub → Plane
 *   - A PR whose head branch or title names a ticket (`paseo-7-…` branch, or "PASEO-7" anywhere in
 *     the title) updates THAT ticket: adds the PR link and moves it with the PR
 *     (draft → In Progress, open → In Review, merged → Done). Closing without merging leaves the
 *     ticket's state alone: the work is not necessarily abandoned.
 *   - Any other PR gets its own work item, keyed by `<repo>#<number>` and tagged with $PLANE_LABEL,
 *     whose title/description GitHub owns. Closing unmerged → Cancelled.
 * Plane → GitHub
 *   - The PR gets one comment linking its Plane ticket, edited in place on later runs.
 *
 *   node scripts/plane-pr-sync.mjs                 the PR in $GITHUB_EVENT_PATH (workflow)
 *   node scripts/plane-pr-sync.mjs --all           every PR in the repo, oldest first (backfill)
 *   node scripts/plane-pr-sync.mjs --pr 12         one PR
 *   … --dry-run                                    print the plan, change nothing
 *
 * Env: PLANE_API_KEY, PLANE_URL (https://plane.aight.to), PLANE_WORKSPACE (aight),
 *      PLANE_PROJECT (identifier, e.g. PASEO), PLANE_LABEL (label for untracked PRs; created if
 *      missing), GITHUB_REPOSITORY (owner/repo), GH_TOKEN or GITHUB_TOKEN (PR reads + comment).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MARKER = "<!-- plane-pr-sync -->";
const MAX_NAME = 255;
const MAX_SUMMARY = 600;

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

/** "In Progress" | "In Review" | "Done" | "Cancelled" | null (leave the state alone). */
export function stateFor(pr, { linked }) {
  if (pr.mergedAt) return "Done";
  if (pr.state.toLowerCase() === "closed") return linked ? null : "Cancelled";
  return pr.draft ? "In Progress" : "In Review";
}

/** The ticket a PR works on, from its branch (`paseo-7-slug`) or title ("PASEO-7: …"). */
export function ticketRef(pr, projectKey) {
  const key = projectKey.toUpperCase();
  const branch = new RegExp(`^(?:[\\w.-]+/)?${key}-(\\d+)(?:[-_/]|$)`, "i").exec(pr.headRef);
  if (branch) return Number(branch[1]);
  const title = new RegExp(`\\b${key}-(\\d+)\\b`, "i").exec(pr.title);
  return title ? Number(title[1]) : null;
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Calendar date in Hong Kong (the team's sprint timezone), YYYY-MM-DD. */
export function hkDate(iso) {
  return new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10);
}

/** The PR body's opening paragraph as plain text, without headings, footers, or markup. */
export function summaryOf(body) {
  if (!body) return "";
  const paragraphs = body
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !/^🤖|^https?:\/\/\S+$|^<!--/.test(p));
  const text = (paragraphs[0] ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

export function externalId(repo, number) {
  return `${repo.split("/").pop()}#${number}`;
}

/** Fields for a PR that has its own work item (no ticket reference). */
export function ownItem(pr, repo) {
  const suffix = ` (${externalId(repo, pr.number)})`;
  const title = pr.title.trim();
  const name =
    title.length + suffix.length > MAX_NAME
      ? `${title.slice(0, MAX_NAME - suffix.length - 1)}…${suffix}`
      : `${title}${suffix}`;
  const meta = [
    `<a href="${escapeHtml(pr.url)}">${escapeHtml(repo)} #${pr.number}</a>`,
    `<code>${escapeHtml(pr.headRef)}</code> → <code>${escapeHtml(pr.baseRef)}</code>`,
    pr.author ? `opened by ${escapeHtml(pr.author)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const summary = summaryOf(pr.body);
  return {
    name,
    external_id: externalId(repo, pr.number),
    external_source: "github",
    description_html: `<p>${meta}</p>${summary ? `<p>${escapeHtml(summary)}</p>` : ""}<p><em>Synced from GitHub; edits here are overwritten on the next PR update.</em></p>`,
    start_date: hkDate(pr.createdAt),
    target_date: pr.mergedAt ? hkDate(pr.mergedAt) : pr.closedAt ? hkDate(pr.closedAt) : null,
  };
}

export function commentBody({ key, url, linked }) {
  const how = linked
    ? "This PR works on it; the ticket moves with the PR (draft → In Progress, open → In Review, merged → Done)."
    : "Tracked as its own work item; name a ticket (e.g. `PASEO-12`) in the branch or title to link an existing one instead.";
  return `${MARKER}\nPlane: [${key}](${url}). ${how}`;
}

export function fromWebhook(p) {
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    body: p.body,
    author: p.user?.login ?? null,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    draft: p.draft ?? false,
    state: p.state,
    createdAt: p.created_at,
    mergedAt: p.merged_at,
    closedAt: p.closed_at,
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Plane {
  constructor({ baseUrl, apiKey, workspace, project, label }, fetcher = fetch) {
    Object.assign(this, {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      workspace,
      project,
      label,
    });
    this.fetcher = fetcher;
    this.states = new Map();
  }

  async request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetcher(`${this.baseUrl}/api/v1/workspaces/${this.workspace}${path}`, {
        method,
        headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 10_000;
        await sleep(Math.min(wait + 500, 65_000));
        continue;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (res.status >= 400 && res.status !== 404) {
        throw new Error(
          `plane: ${method} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      return { status: res.status, data };
    }
  }

  async list(path) {
    const { data } = await this.request(
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100`,
    );
    return Array.isArray(data) ? data : (data?.results ?? []);
  }

  async init() {
    const project = (await this.list("/projects/")).find((p) => p.identifier === this.project);
    if (!project) throw new Error(`plane: no project ${this.project} in ${this.workspace}`);
    this.projectId = project.id;
    for (const s of await this.list(`/projects/${project.id}/states/`))
      this.states.set(s.name, s.id);
    const labels = await this.list(`/projects/${project.id}/labels/`);
    let label = labels.find((l) => l.name === this.label);
    if (!label) {
      label = (await this.request("POST", `/projects/${project.id}/labels/`, { name: this.label }))
        .data;
    }
    this.labelId = label.id;
  }

  stateId(name) {
    const id = this.states.get(name);
    if (!id) throw new Error(`plane: no state "${name}" in ${this.project}`);
    return id;
  }

  itemUrl(sequence) {
    return `${this.baseUrl}/${this.workspace}/browse/${this.project}-${sequence}/`;
  }

  async addLink(itemId, url, title) {
    const base = `/projects/${this.projectId}/work-items/${itemId}/links/`;
    const links = await this.list(base);
    if (links.some((l) => l.url === url)) return;
    await this.request("POST", base, { url, title });
  }

  /** Moves the referenced ticket with the PR. Returns null when the ticket does not exist. */
  async syncLinked(pr, sequence) {
    const found = await this.request("GET", `/work-items/${this.project}-${sequence}/`);
    if (found.status === 404 || !found.data?.id) return null;
    const state = stateFor(pr, { linked: true });
    if (state) {
      await this.request("PATCH", `/projects/${this.projectId}/work-items/${found.data.id}/`, {
        state: this.stateId(state),
      });
    }
    await this.addLink(found.data.id, pr.url, `GitHub PR #${pr.number}`);
    return {
      key: `${this.project}-${sequence}`,
      url: this.itemUrl(sequence),
      state,
      created: false,
    };
  }

  async syncOwn(pr, repo) {
    const item = ownItem(pr, repo);
    const base = `/projects/${this.projectId}/work-items/`;
    const fields = { ...item, state: this.stateId(stateFor(pr, { linked: false })) };
    const found = await this.request(
      "GET",
      `${base}?external_id=${encodeURIComponent(item.external_id)}&external_source=github`,
    );
    if (found.status === 200 && found.data?.id) {
      // Labels set in Plane are kept; only add ours when missing.
      const current = found.data.labels ?? [];
      const patch = current.includes(this.labelId)
        ? fields
        : { ...fields, labels: [...current, this.labelId] };
      await this.request("PATCH", `${base}${found.data.id}/`, patch);
      const seq = found.data.sequence_id;
      return { key: `${this.project}-${seq}`, url: this.itemUrl(seq), state: null, created: false };
    }
    const created = await this.request("POST", base, { ...fields, labels: [this.labelId] });
    await this.addLink(created.data.id, pr.url, `GitHub PR #${pr.number}`);
    const seq = created.data.sequence_id;
    return { key: `${this.project}-${seq}`, url: this.itemUrl(seq), state: null, created: true };
  }
}

export class GitHub {
  constructor({ repo, token }, fetcher = fetch) {
    Object.assign(this, { repo, token, fetcher });
  }

  async request(method, path, body) {
    const res = await this.fetcher(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`github: ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  async pulls() {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request("GET", `/pulls?state=all&per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all.map(fromWebhook).sort((a, b) => a.number - b.number);
  }

  async pull(number) {
    return fromWebhook(await this.request("GET", `/pulls/${number}`));
  }

  /** Creates or updates the single sync comment on the PR. */
  async upsertComment(number, body) {
    const comments = await this.request("GET", `/issues/${number}/comments?per_page=100`);
    const mine = comments.find((c) => c.body?.startsWith(MARKER));
    if (mine) {
      if (mine.body !== body) await this.request("PATCH", `/issues/comments/${mine.id}`, { body });
      return;
    }
    await this.request("POST", `/issues/${number}/comments`, { body });
  }
}

async function loadPrs(argv, github) {
  if (argv.includes("--all")) return github.pulls();
  const i = argv.indexOf("--pr");
  if (i !== -1) return [await github.pull(Number(argv[i + 1]))];
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath)
    throw new Error("no PR given: use --all, --pr <n>, or run from a pull_request workflow");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (!event.pull_request) throw new Error("the event has no pull_request");
  return [fromWebhook(event.pull_request)];
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY (owner/repo) is not set");
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is not set");
  const project = env.PLANE_PROJECT || "PASEO";
  const github = new GitHub({ repo, token });
  const prs = await loadPrs(argv, github);

  if (argv.includes("--dry-run")) {
    for (const pr of prs) {
      const ref = ticketRef(pr, project);
      const state = stateFor(pr, { linked: ref !== null });
      console.log(
        `#${pr.number} → ${ref ? `${project}-${ref}` : "own item"} ${state ?? "(state kept)"}  ${pr.title}`,
      );
    }
    return 0;
  }
  if (!env.PLANE_API_KEY) throw new Error("PLANE_API_KEY is not set");
  const plane = new Plane({
    baseUrl: env.PLANE_URL || "https://plane.aight.to",
    apiKey: env.PLANE_API_KEY,
    workspace: env.PLANE_WORKSPACE || "aight",
    project,
    label: env.PLANE_LABEL || repo.split("/").pop(),
  });
  await plane.init();
  for (const pr of prs) {
    const ref = ticketRef(pr, project);
    const linked = ref === null ? null : await plane.syncLinked(pr, ref);
    const result = linked ?? (await plane.syncOwn(pr, repo));
    await github.upsertComment(
      pr.number,
      commentBody({ key: result.key, url: result.url, linked: Boolean(linked) }),
    );
    console.log(
      `#${pr.number} → ${result.key} ${linked ? `(linked${result.state ? `, ${result.state}` : ""})` : result.created ? "(created)" : "(updated)"}`,
    );
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

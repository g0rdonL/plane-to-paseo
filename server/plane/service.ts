import { z } from "zod";
import type {
  Issue,
  IssueComment,
  IssueDetail,
  IssueStartResult,
  IssueState,
  IssuesListResult,
  Label,
  MySprint,
  Project,
  SprintPerson,
  User,
} from "../../shared/contracts";
import { CLOSED_STATE_TYPES } from "../../shared/contracts";
import { assetApiUrl, extractImageRefs, htmlToMarkdown } from "../../shared/plane-markdown";
import { collectPages, type PlaneClient, PlaneError } from "./client";
import { downloadImages, type ImageSource } from "./images";

export const LIST_LIMITS = { perPage: 100, maxItemsPerProject: 500 } as const;
const LIST_CACHE_TTL_MS = 15_000;
const DETAIL_CACHE_TTL_MS = 30_000;
const META_CACHE_TTL_MS = 5 * 60_000;
const FAN_OUT_CONCURRENCY = 4;
const DESCRIPTION_PREVIEW_LIMIT = 2_000;
const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

// ---------------------------------------------------------------------------
// Raw Plane v1 shapes. Only the fields we read are declared; the rest pass through.
// ---------------------------------------------------------------------------

const rawUser = z.object({
  id: z.string(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  display_name: z.string().nullish(),
  email: z.string().nullish(),
  avatar_url: z.string().nullish(),
  avatar: z.string().nullish(),
});
const rawMember = z.union([
  rawUser,
  // Some versions nest the user under `member`.
  z.object({ member: rawUser }).transform((value) => value.member),
]);
const rawProject = z.object({
  id: z.string(),
  identifier: z.string(),
  name: z.string(),
  archived_at: z.string().nullish(),
});
const rawState = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string(),
  color: z.string().nullish(),
  sequence: z.number().nullish(),
});
const rawLabel = z.object({ id: z.string(), name: z.string(), color: z.string().nullish() });
const idOrObject = z.union([
  z.string(),
  z.object({ id: z.string() }).transform((value) => value.id),
]);
export const rawWorkItem = z.object({
  id: z.string(),
  name: z.string(),
  sequence_id: z.number(),
  project: z.string().nullish(),
  project_id: z.string().nullish(),
  state: idOrObject.nullish(),
  priority: z.string().nullish(),
  assignees: z.array(idOrObject).nullish(),
  labels: z.array(idOrObject).nullish(),
  description_html: z.string().nullish(),
  target_date: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullish(),
  /** An id, or `{ id, project_id }` when requested with `expand=parent`. */
  parent: z
    .union([
      z.string().transform((id) => ({ id, project_id: null as string | null })),
      // With no parent, `expand=parent` serialises None as `{}` rather than null.
      z
        .object({ id: z.string().nullish(), project_id: z.string().nullish() })
        .transform((value) =>
          value.id ? { id: value.id, project_id: value.project_id ?? null } : null,
        ),
    ])
    .nullish(),
  created_by: z.string().nullish(),
  cycle_id: z.string().nullish(),
  /**
   * An id, or `{ value }` when requested with `expand=estimate_point`. Like `parent`, a missing
   * estimate expands to an object with an empty value rather than null.
   */
  estimate_point: z
    .union([
      z.string().transform(() => null),
      z.object({ value: z.string().nullish() }).transform((point) => point.value || null),
    ])
    .nullish(),
});
const rawComment = z.object({
  id: z.string(),
  comment_html: z.string().nullish(),
  created_at: z.string(),
  actor: z.string().nullish(),
  created_by: z.string().nullish(),
});
const rawLink = z.object({ id: z.string(), title: z.string().nullish(), url: z.string() });
const rawAttachment = z.object({
  id: z.string(),
  attributes: z
    .object({ name: z.string().nullish(), type: z.string().nullish(), size: z.number().nullish() })
    .nullish(),
});
const rawSearchHit = z.object({ id: z.string(), project_id: z.string() });
const assetResponse = z.object({ asset_url: z.string() });
/** Past weeks listed in the sprint picker, besides the current and next ones. */
const SPRINT_WEEKS_BACK = 4;
const sprintPeopleResponse = z.array(
  z.object({
    id: z.string(),
    display_name: z.string(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    is_me: z.boolean(),
  }),
);
const sprintCapacityResponse = z.object({
  capacity: z.number().default(0),
  buffer_capacity: z.number().default(0),
  sprints: z.array(
    z.object({
      label: z.string(),
      start_date: z.string(),
      end_date: z.string(),
      is_current: z.boolean(),
      planned_points: z.number().default(0),
      buffer_points: z.number().default(0),
      done_points: z.number().default(0),
      unestimated: z.number().default(0),
      items: z.array(z.object({ id: z.string() })),
    }),
  ),
});

type RawWorkItem = z.output<typeof rawWorkItem>;
type RawState = z.output<typeof rawState>;

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

export const PRIORITY_RANKS: Record<string, { rank: number; label: string }> = {
  urgent: { rank: 1, label: "Urgent" },
  high: { rank: 2, label: "High" },
  medium: { rank: 3, label: "Medium" },
  low: { rank: 4, label: "Low" },
  none: { rank: 0, label: "No priority" },
};

export function userName(user: z.output<typeof rawUser>): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || user.display_name || user.email || "Unknown";
}

export function toUser(user: z.output<typeof rawUser>): User {
  return {
    id: user.id,
    name: userName(user),
    displayName: user.display_name ?? null,
    avatarUrl: user.avatar_url || user.avatar || null,
  };
}

export function branchNameFor(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug ? `${identifier.toLowerCase()}-${slug}` : identifier.toLowerCase();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline Markdown the hand-off comment uses: `code` and **bold**. Input is already escaped. */
function inlineMarkdownToHtml(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

/** Plain text (one paragraph per blank-line block) to the HTML Plane's comment API expects. */
export function textToCommentHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${inlineMarkdownToHtml(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Lowest-sequence state in the `started` group, matching Plane's own ordering. */
const STATE_GROUP_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "cancelled"];

export function toIssueState(state: RawState): IssueState {
  return {
    id: state.id,
    name: state.name,
    type: state.group,
    color: state.color ?? null,
    position: state.sequence ?? null,
  };
}

export function firstStartedState(states: readonly RawState[]): RawState | null {
  return (
    [...states]
      .filter((state) => state.group === "started")
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0] ?? null
  );
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  at: number;
}

interface ProjectMeta {
  project: Project;
  states: Map<string, RawState>;
  labels: Map<string, Label>;
}

export interface Bootstrap {
  viewer: User & { email: string | null };
  members: Map<string, User>;
  projects: Project[];
}

export interface PlaneServiceOptions {
  client: PlaneClient;
  workspaceSlug: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * One instance per credential set. Holds short-lived caches so the desktop app, a phone, and a
 * re-mount within a few seconds do not multiply the fan-out across every project.
 */
export class PlaneService {
  private readonly client: PlaneClient;
  readonly workspaceSlug: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private bootstrapCache: CacheEntry<Bootstrap> | null = null;
  private metaCache = new Map<string, CacheEntry<ProjectMeta>>();
  private membersCache = new Map<string, CacheEntry<User[]>>();
  private sprintCache = new Map<string, CacheEntry<MySprint[]>>();
  private listCache = new Map<string, CacheEntry<IssuesListResult>>();
  private detailCache = new Map<string, CacheEntry<IssueDetail>>();

  constructor(options: PlaneServiceOptions) {
    this.client = options.client;
    this.workspaceSlug = options.workspaceSlug;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private get ws(): string {
    return `workspaces/${encodeURIComponent(this.workspaceSlug)}`;
  }

  private fresh<T>(entry: CacheEntry<T> | null | undefined, ttl: number): entry is CacheEntry<T> {
    return Boolean(entry && this.now() - entry.at < ttl);
  }

  invalidate(): void {
    this.listCache.clear();
    this.detailCache.clear();
    this.sprintCache.clear();
  }

  issueUrl(identifier: string): string {
    return `${this.client.instanceUrl}/${encodeURIComponent(this.workspaceSlug)}/browse/${identifier}/`;
  }

  async bootstrap(refresh = false): Promise<Bootstrap> {
    if (!refresh && this.fresh(this.bootstrapCache, META_CACHE_TTL_MS)) {
      return this.bootstrapCache.value;
    }
    const [me, members, projects] = await Promise.all([
      this.client.get("users/me/"),
      this.client.get(`${this.ws}/members/`),
      collectPages<unknown>(
        this.client,
        `${this.ws}/projects/`,
        {},
        { perPage: 100, maxItems: 500 },
      ),
    ]);
    const viewerRaw = rawUser.parse(me);
    const memberMap = new Map<string, User>();
    const memberList = Array.isArray(members)
      ? members
      : ((members as { results?: unknown[] })?.results ?? []);
    for (const entry of memberList) {
      const parsed = rawMember.safeParse(entry);
      if (parsed.success) memberMap.set(parsed.data.id, toUser(parsed.data));
    }
    const viewer = { ...toUser(viewerRaw), email: viewerRaw.email ?? null };
    memberMap.set(viewer.id, toUser(viewerRaw));
    const value: Bootstrap = {
      viewer,
      members: memberMap,
      projects: projects.items
        .map((raw) => rawProject.parse(raw))
        .filter((project) => !project.archived_at)
        .map((project) => ({ id: project.id, key: project.identifier, name: project.name }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
    this.bootstrapCache = { value, at: this.now() };
    return value;
  }

  private async projectMeta(projectId: string, refresh = false): Promise<ProjectMeta> {
    const cached = this.metaCache.get(projectId);
    if (!refresh && this.fresh(cached, META_CACHE_TTL_MS)) return cached.value;
    const bootstrap = await this.bootstrap();
    let project = bootstrap.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      const raw = rawProject.parse(await this.client.get(`${this.ws}/projects/${projectId}/`));
      project = { id: raw.id, key: raw.identifier, name: raw.name };
    }
    const base = `${this.ws}/projects/${projectId}`;
    const [states, labels] = await Promise.all([
      collectPages<unknown>(this.client, `${base}/states/`, {}, { perPage: 100, maxItems: 500 }),
      collectPages<unknown>(this.client, `${base}/labels/`, {}, { perPage: 100, maxItems: 1000 }),
    ]);
    const value: ProjectMeta = {
      project,
      states: new Map(states.items.map((raw) => rawState.parse(raw)).map((s) => [s.id, s])),
      labels: new Map(
        labels.items
          .map((raw) => rawLabel.parse(raw))
          .map((label) => [
            label.id,
            { id: label.id, name: label.name, color: label.color ?? null },
          ]),
      ),
    };
    this.metaCache.set(projectId, { value, at: this.now() });
    return value;
  }

  toIssue(raw: RawWorkItem, meta: ProjectMeta, members: Map<string, User>): Issue {
    const identifier = `${meta.project.key}-${raw.sequence_id}`;
    const state = raw.state ? meta.states.get(raw.state) : undefined;
    const priority = PRIORITY_RANKS[raw.priority ?? "none"] ?? PRIORITY_RANKS.none;
    const description = htmlToMarkdown(raw.description_html);
    return {
      id: raw.id,
      identifier,
      title: raw.name,
      url: this.issueUrl(identifier),
      branchName: branchNameFor(identifier, raw.name),
      priority: priority?.rank ?? 0,
      priorityLabel: priority?.label ?? "No priority",
      estimate: raw.estimate_point ?? null,
      dueDate: raw.target_date ?? null,
      createdById: raw.created_by ?? null,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      completedAt: raw.completed_at ?? null,
      state: state
        ? toIssueState(state)
        : {
            id: raw.state ?? "unknown",
            name: "Unknown",
            type: "backlog",
            color: null,
            position: null,
          },
      project: meta.project,
      assignees: (raw.assignees ?? [])
        .map((id) => members.get(id))
        .filter((user): user is User => Boolean(user)),
      labels: (raw.labels ?? [])
        .map((id) => meta.labels.get(id))
        .filter((label): label is Label => Boolean(label)),
      commentCount: null,
      descriptionPreview: description ? description.slice(0, DESCRIPTION_PREVIEW_LIMIT) : null,
    };
  }

  /**
   * Plane CE has no cross-project query endpoint (advanced-search is Commercial Edition only) and
   * its list endpoint rejects filters, so this fans out over every project and filters locally.
   */
  async listIssues(input: { includeClosed: boolean; refresh: boolean }): Promise<IssuesListResult> {
    const key = input.includeClosed ? "all" : "open";
    const cached = this.listCache.get(key);
    if (!input.refresh && this.fresh(cached, LIST_CACHE_TTL_MS)) return cached.value;

    const bootstrap = await this.bootstrap(input.refresh);
    const perProject = await mapLimit(bootstrap.projects, FAN_OUT_CONCURRENCY, async (project) => {
      const [meta, pages] = await Promise.all([
        this.projectMeta(project.id, input.refresh),
        collectPages<unknown>(
          this.client,
          `${this.ws}/projects/${project.id}/work-items/`,
          { order_by: "-updated_at", expand: "estimate_point" },
          { perPage: LIST_LIMITS.perPage, maxItems: LIST_LIMITS.maxItemsPerProject },
        ),
      ]);
      const issues = pages.items.map((raw) =>
        this.toIssue(rawWorkItem.parse(raw), meta, bootstrap.members),
      );
      return { issues, truncated: pages.truncated };
    });

    const closed = new Set<string>(CLOSED_STATE_TYPES);
    const issues = perProject
      .flatMap((entry) => entry.issues)
      .filter((issue) => input.includeClosed || !closed.has(issue.state.type))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const result: IssuesListResult = {
      issues,
      projects: bootstrap.projects,
      viewer: { id: bootstrap.viewer.id, name: bootstrap.viewer.name },
      fetchedAt: new Date(this.now()).toISOString(),
      truncated: perProject.some((entry) => entry.truncated),
    };
    this.listCache.set(key, { value: result, at: this.now() });
    return result;
  }

  private async fetchIssue(
    projectId: string,
    issueId: string,
    query: { expand?: string } = { expand: "estimate_point" },
  ): Promise<{ raw: RawWorkItem; issue: Issue; meta: ProjectMeta }> {
    const [bootstrap, meta, data] = await Promise.all([
      this.bootstrap(),
      this.projectMeta(projectId),
      this.client.get(`${this.ws}/projects/${projectId}/work-items/${issueId}/`, query),
    ]);
    const raw = rawWorkItem.parse(data);
    return { raw, meta, issue: this.toIssue(raw, meta, bootstrap.members) };
  }

  private cachedIssue(issueId: string): Issue | undefined {
    for (const entry of this.listCache.values()) {
      const hit = entry.value.issues.find((issue) => issue.id === issueId);
      if (hit) return hit;
    }
    return undefined;
  }

  async issueByIdentifier(identifier: string): Promise<Issue | null> {
    const match = IDENTIFIER.exec(identifier.trim());
    if (!match) return null;
    const key = `${match[1]?.toUpperCase()}-${match[2]}`;
    try {
      const raw = rawWorkItem.parse(await this.client.get(`${this.ws}/work-items/${key}/`));
      const projectId = raw.project_id ?? raw.project;
      if (!projectId) return null;
      const [bootstrap, meta] = await Promise.all([this.bootstrap(), this.projectMeta(projectId)]);
      return this.toIssue(raw, meta, bootstrap.members);
    } catch (error) {
      if (error instanceof PlaneError && error.kind === "not_found") return null;
      throw error;
    }
  }

  async searchIssues(term: string, limit = 25): Promise<Issue[]> {
    const trimmed = term.trim();
    if (!trimmed) return [];
    if (IDENTIFIER.test(trimmed)) {
      const exact = await this.issueByIdentifier(trimmed);
      if (exact) return [exact];
    }
    const data = (await this.client.get(`${this.ws}/work-items/search/`, {
      search: trimmed,
      workspace_search: true,
      limit,
    })) as { issues?: unknown[] };
    const hits = (data.issues ?? []).flatMap((hit) => {
      const parsed = rawSearchHit.safeParse(hit);
      return parsed.success ? [parsed.data] : [];
    });
    const issues = await mapLimit(hits, FAN_OUT_CONCURRENCY, async (hit) => {
      const cached = this.cachedIssue(hit.id);
      if (cached) return cached;
      try {
        return (await this.fetchIssue(hit.project_id, hit.id)).issue;
      } catch {
        return null;
      }
    });
    return issues.filter((issue): issue is Issue => Boolean(issue));
  }

  /** Swaps a Plane asset API URL for its presigned download URL. Other URLs pass through. */
  private async resolveAssetUrl(url: string): Promise<string> {
    const apiPrefix = `${this.client.instanceUrl}/api/v1/`;
    if (!url.startsWith(apiPrefix)) return url;
    const { asset_url } = assetResponse.parse(await this.client.get(url.slice(apiPrefix.length)));
    const resolved = new URL(asset_url, this.client.instanceUrl);
    // Behind a TLS-terminating proxy Plane may sign an http:// URL for its own host; SigV4 signs
    // the host, not the scheme, so upgrading keeps the signature valid.
    const instance = new URL(this.client.instanceUrl);
    if (resolved.host === instance.host && resolved.protocol !== instance.protocol) {
      resolved.protocol = instance.protocol;
    }
    return resolved.toString();
  }

  async issueDetail(
    input: { issueId: string; projectId: string },
    refresh = false,
  ): Promise<IssueDetail> {
    const cacheKey = `${input.projectId}/${input.issueId}`;
    const cached = this.detailCache.get(cacheKey);
    if (!refresh && this.fresh(cached, DETAIL_CACHE_TTL_MS)) return cached.value;

    const base = `${this.ws}/projects/${input.projectId}/work-items/${input.issueId}`;
    const [{ raw, issue }, bootstrap, comments, links, attachments] = await Promise.all([
      this.fetchIssue(input.projectId, input.issueId, { expand: "parent,estimate_point" }),
      this.bootstrap(),
      collectPages<unknown>(
        this.client,
        `${base}/comments/`,
        { order_by: "created_at" },
        { perPage: 100, maxItems: 300 },
      ),
      collectPages<unknown>(this.client, `${base}/links/`, {}, { perPage: 100, maxItems: 100 }),
      this.client.get(`${base}/attachments/`).catch(() => []),
    ]);

    const markdownOptions = {
      resolveAsset: (id: string) => assetApiUrl(this.client.instanceUrl, this.workspaceSlug, id),
      resolveMention: (id: string) => bootstrap.members.get(id)?.name ?? null,
    };

    let parent: IssueDetail["parent"] = null;
    if (raw.parent) {
      const parentRef = raw.parent;
      const parentIssue =
        this.cachedIssue(parentRef.id) ??
        (await this.fetchIssue(parentRef.project_id ?? input.projectId, parentRef.id)
          .then((r) => r.issue)
          .catch(() => null));
      if (parentIssue) {
        parent = {
          identifier: parentIssue.identifier,
          title: parentIssue.title,
          url: parentIssue.url,
        };
      }
    }

    const commentList: IssueComment[] = comments.items
      .map((value) => rawComment.parse(value))
      .map((comment) => {
        const authorId = comment.actor ?? comment.created_by;
        return {
          id: comment.id,
          body: htmlToMarkdown(comment.comment_html, markdownOptions),
          createdAt: comment.created_at,
          user: authorId ? (bootstrap.members.get(authorId) ?? null) : null,
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const attachmentList = (
      Array.isArray(attachments)
        ? attachments
        : ((attachments as { results?: unknown[] }).results ?? [])
    ).flatMap((value) => {
      const parsed = rawAttachment.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });

    const description = htmlToMarkdown(raw.description_html, markdownOptions);
    const detail: Omit<IssueDetail, "images"> = {
      ...issue,
      commentCount: commentList.length,
      description: description || null,
      creator: raw.created_by ? (bootstrap.members.get(raw.created_by) ?? null) : null,
      cycle: null,
      parent,
      comments: commentList,
      attachments: [
        ...links.items
          .map((value) => rawLink.parse(value))
          .map((link) => ({
            id: link.id,
            title: link.title ?? null,
            url: link.url,
            sourceType: "link",
          })),
        ...attachmentList.map((file) => ({
          id: file.id,
          title: file.attributes?.name ?? "Attachment",
          url: issue.url,
          sourceType: file.attributes?.type ?? "file",
        })),
      ],
    };

    const sources: ImageSource[] = extractImageRefs(detail.description).map((ref) => ({
      ...ref,
      source: "description" as const,
      commentId: null,
    }));
    const seen = new Set(sources.map((source) => source.url));
    for (const comment of detail.comments) {
      for (const ref of extractImageRefs(comment.body)) {
        if (seen.has(ref.url)) continue;
        seen.add(ref.url);
        sources.push({ ...ref, source: "comment", commentId: comment.id });
      }
    }
    for (const file of attachmentList) {
      if (!file.attributes?.type?.startsWith("image/")) continue;
      const url = assetApiUrl(this.client.instanceUrl, this.workspaceSlug, file.id);
      if (seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        alt: file.attributes.name ?? null,
        source: "attachment",
        commentId: null,
      });
    }

    const images = await downloadImages(sources, {
      fetchImpl: this.fetchImpl,
      resolveUrl: (url) => this.resolveAssetUrl(url),
    });
    const failed = images.filter((image) => image.error).length;
    if (failed > 0) {
      console.warn(
        `[plane-to-paseo] ${detail.identifier}: ${failed}/${images.length} image downloads failed`,
      );
    }

    const value: IssueDetail = { ...detail, images };
    this.detailCache.set(cacheKey, { value, at: this.now() });
    return value;
  }

  async projectStates(projectId: string, refresh = false): Promise<IssueState[]> {
    const meta = await this.projectMeta(projectId, refresh);
    return [...meta.states.values()]
      .sort(
        (a, b) =>
          STATE_GROUP_ORDER.indexOf(a.group) - STATE_GROUP_ORDER.indexOf(b.group) ||
          (a.sequence ?? 0) - (b.sequence ?? 0),
      )
      .map(toIssueState);
  }

  async setState(input: {
    issueId: string;
    projectId: string;
    stateId: string;
  }): Promise<{ state: IssueState }> {
    const meta = await this.projectMeta(input.projectId);
    const target = meta.states.get(input.stateId);
    if (!target) throw new PlaneError("That state does not belong to this project", "http", 400);
    await this.client.patch(`${this.ws}/projects/${input.projectId}/work-items/${input.issueId}/`, {
      state: input.stateId,
    });
    this.invalidate();
    return { state: toIssueState(target) };
  }

  /**
   * Sprints from the Aight fork's `users/me/sprint-capacity/` endpoint, SPRINT_WEEKS_BACK weeks ago
   * through next week, for the viewer or for `userId`. Forks that predate the `offsets` parameter
   * ignore it and answer with this week and next only. Stock Plane has no such endpoint; that is
   * not an error, just no sprint filter.
   */
  async mySprints(userId?: string | null): Promise<MySprint[]> {
    const key = userId ?? "me";
    const cached = this.sprintCache.get(key);
    if (this.fresh(cached, LIST_CACHE_TTL_MS)) return cached.value;
    let value: MySprint[] = [];
    try {
      const offsets = Array.from(
        { length: SPRINT_WEEKS_BACK + 2 },
        (_, i) => i - SPRINT_WEEKS_BACK,
      );
      const data = sprintCapacityResponse.parse(
        await this.client.get("users/me/sprint-capacity/", {
          offsets: offsets.join(","),
          ...(userId ? { user_id: userId } : {}),
        }),
      );
      value = data.sprints.map((sprint) => ({
        label: sprint.label,
        startDate: sprint.start_date,
        endDate: sprint.end_date,
        isCurrent: sprint.is_current,
        plannedPoints: sprint.planned_points,
        bufferPoints: sprint.buffer_points,
        donePoints: sprint.done_points,
        capacity: data.capacity,
        bufferCapacity: data.buffer_capacity,
        unestimated: sprint.unestimated,
        issueIds: sprint.items.map((item) => item.id),
      }));
    } catch (error) {
      if (!(error instanceof PlaneError && error.kind === "not_found")) throw error;
    }
    this.sprintCache.set(key, { value, at: this.now() });
    return value;
  }

  /** Whose sprint the viewer may open, viewer first. Empty on Plane builds without the endpoint. */
  async sprintPeople(): Promise<SprintPerson[]> {
    let raw: z.output<typeof sprintPeopleResponse> = [];
    try {
      raw = sprintPeopleResponse.parse(await this.client.get("users/me/sprint-capacity/people/"));
    } catch (error) {
      if (!(error instanceof PlaneError && error.kind === "not_found")) throw error;
    }
    return raw
      .map((person) => ({
        id: person.id,
        name: `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() || person.display_name,
        isMe: person.is_me,
      }))
      .sort((a, b) => Number(b.isMe) - Number(a.isMe));
  }

  /** People who can be assigned in a project. Plane rejects assignees outside the project. */
  async projectMembers(projectId: string, refresh = false): Promise<User[]> {
    const cached = this.membersCache.get(projectId);
    if (!refresh && this.fresh(cached, META_CACHE_TTL_MS)) return cached.value;
    const data = await this.client.get(`${this.ws}/projects/${projectId}/members/`);
    const list = Array.isArray(data) ? data : ((data as { results?: unknown[] })?.results ?? []);
    const members = list
      .flatMap((entry) => {
        const parsed = rawMember.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
      // Plane auto-creates a bot user per workspace; it is not a person to assign.
      .filter(
        (user) =>
          !/^bot_user_/i.test(user.email ?? "") && !/^bot_user_/i.test(user.display_name ?? ""),
      )
      .map(toUser)
      .sort((a, b) => a.name.localeCompare(b.name));
    this.membersCache.set(projectId, { value: members, at: this.now() });
    return members;
  }

  async setAssignees(input: {
    issueId: string;
    projectId: string;
    assigneeIds: string[];
  }): Promise<{ assignees: User[] }> {
    const assigneeIds = [...new Set(input.assigneeIds)];
    const updated = rawWorkItem.parse(
      await this.client.patch(
        `${this.ws}/projects/${input.projectId}/work-items/${input.issueId}/`,
        {
          assignees: assigneeIds,
        },
      ),
    );
    const [bootstrap, members] = await Promise.all([
      this.bootstrap(),
      this.projectMembers(input.projectId).catch(() => [] as User[]),
    ]);
    const known = new Map([
      ...bootstrap.members,
      ...members.map((user) => [user.id, user] as const),
    ]);
    this.invalidate();
    return {
      assignees: (updated.assignees ?? assigneeIds)
        .map((id) => known.get(id))
        .filter((user): user is User => Boolean(user)),
    };
  }

  async startIssue(input: {
    issueId: string;
    projectId: string;
    moveToStarted: boolean;
    assignToMe: boolean;
    comment: string;
  }): Promise<IssueStartResult> {
    const warnings: string[] = [];
    let moved = false;
    let assigned = false;
    let commented = false;
    const path = `${this.ws}/projects/${input.projectId}/work-items/${input.issueId}/`;

    const update: { state?: string; assignees?: string[] } = {};
    if (input.moveToStarted || input.assignToMe) {
      try {
        const { raw, meta } = await this.fetchIssue(input.projectId, input.issueId);
        if (input.moveToStarted) {
          const started = firstStartedState([...meta.states.values()]);
          const current = raw.state ? meta.states.get(raw.state) : undefined;
          if (!started) {
            warnings.push("This project has no 'started' state, so the work item was not moved.");
          } else if (current?.group === "started" || current?.group === "completed") {
            // Never pull finished or already-active work backwards.
          } else {
            update.state = started.id;
          }
        }
        if (input.assignToMe) {
          const { viewer } = await this.bootstrap();
          const existing = raw.assignees ?? [];
          if (!existing.includes(viewer.id)) update.assignees = [...existing, viewer.id];
        }
      } catch (error) {
        warnings.push(
          `Could not read the work item before updating it: ${(error as Error).message}`,
        );
      }
    }
    if (Object.keys(update).length > 0) {
      try {
        await this.client.patch(path, update);
        moved = "state" in update;
        assigned = "assignees" in update;
      } catch (error) {
        warnings.push(`Work item update failed: ${(error as Error).message}`);
        this.metaCache.delete(input.projectId);
      }
    }
    if (input.comment.trim()) {
      try {
        await this.client.post(`${path}comments/`, {
          comment_html: textToCommentHtml(input.comment),
        });
        commented = true;
      } catch (error) {
        warnings.push(`Comment failed: ${(error as Error).message}`);
      }
    }
    this.invalidate();
    return { moved, assigned, commented, warnings };
  }
}

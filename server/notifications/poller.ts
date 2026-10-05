import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCredentials } from "../credentials";
import { createPlaneClient, type PlaneClient, type PlanePage } from "../plane/client";
import {
  type DetectedNotification,
  detectNotifications,
  type PlaneActivity,
  type PlaneComment,
} from "./detect";

/**
 * Publishes Plane events for the viewer to the Plugin Launcher inbox
 * (`~/.paseo/plugin-inbox/plane-to-paseo.json`). Unread state lives here; the launcher's
 * "Mark seen" writes `~/.paseo/plugin-inbox/seen/plane-to-paseo.json`, which this prunes.
 */
export const PLUGIN_ID = "plane-to-paseo";
export const POLL_MS = 3 * 60_000;
/** Each changed item costs two requests; Plane allows 60/min per key, shared with the UI and CI. */
const MAX_CHANGED_ITEMS = 8;
const MAX_NOTIFICATIONS = 100;
const KEEP_MS = 14 * 24 * 60 * 60_000;

export interface NotifierPaths {
  inboxDir: string;
  statePath: string;
}

export function defaultPaths(): NotifierPaths {
  const paseo = join(homedir(), ".paseo");
  return {
    inboxDir: join(paseo, "plugin-inbox"),
    statePath: join(paseo, "plugin-data", PLUGIN_ID, "notifications.json"),
  };
}

interface NotifierState {
  version: 1;
  /** Workspace + user the cursors belong to; a different login starts over. */
  identity: string;
  cursors: Record<string, string>;
  notifications: DetectedNotification[];
}

interface PlaneProject {
  id: string;
  identifier: string;
}

interface PlaneIssue {
  id: string;
  name: string;
  sequence_id: number;
  updated_at: string;
  assignees: string[];
  created_by: string | null;
}

interface PlaneMember {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
}

function results<T>(page: PlanePage<T> | T[]): T[] {
  return Array.isArray(page) ? page : (page.results ?? []);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

let writeSequence = 0;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${++writeSequence}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function mergeNotifications(
  existing: DetectedNotification[],
  added: DetectedNotification[],
  seenIds: Set<string>,
  now: number,
): DetectedNotification[] {
  const byId = new Map<string, DetectedNotification>();
  for (const notification of [...existing, ...added]) byId.set(notification.id, notification);
  return [...byId.values()]
    .filter((n) => !seenIds.has(n.id) && now - Date.parse(n.createdAt) < KEEP_MS)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_NOTIFICATIONS);
}

export async function pollOnce(
  client: PlaneClient,
  workspaceSlug: string,
  paths: NotifierPaths,
  now = Date.now(),
): Promise<number> {
  const ws = encodeURIComponent(workspaceSlug);
  const me = (await client.get<{ id: string }>("users/me/")).id;
  const identity = `${client.instanceUrl}\n${workspaceSlug}\n${me}`;
  const stored = await readJson<NotifierState>(paths.statePath);
  const state: NotifierState =
    stored?.version === 1 && stored.identity === identity
      ? stored
      : { version: 1, identity, cursors: {}, notifications: [] };

  const members = results(await client.get<PlaneMember[]>(`workspaces/${ws}/members/`));
  const names = new Map(members.map((m) => [m.id, m.display_name || m.first_name || "Someone"]));
  const nameOf = (id: string | null | undefined) => (id && names.get(id)) || "Someone";

  const projects = results(
    await client.get<PlanePage<PlaneProject>>(`workspaces/${ws}/projects/`, { per_page: 100 }),
  );
  const added: DetectedNotification[] = [];
  let budget = MAX_CHANGED_ITEMS;
  let failure: unknown = null;
  outer: for (const project of projects) {
    const base = `workspaces/${ws}/projects/${project.id}/issues/`;
    let issues: PlaneIssue[];
    try {
      issues = results(
        await client.get<PlanePage<PlaneIssue>>(base, { per_page: 50, order_by: "-updated_at" }),
      );
    } catch (error) {
      failure = error;
      break;
    }
    const since = state.cursors[project.id];
    const newest = issues[0]?.updated_at;
    // First sight of a project only records where "now" is; history never notifies.
    if (!since) {
      if (newest) state.cursors[project.id] = newest;
      continue;
    }
    const changed = issues.filter((issue) => issue.updated_at > since).reverse();
    let cursor = since;
    for (const issue of changed) {
      if (budget <= 0) break;
      budget -= 1;
      let activities: PlanePage<PlaneActivity>;
      let comments: PlanePage<PlaneComment>;
      try {
        activities = await client.get(`${base}${issue.id}/activities/`, {
          per_page: 30,
          order_by: "-created_at",
        });
        comments = await client.get(`${base}${issue.id}/comments/`, {
          per_page: 30,
          order_by: "-created_at",
        });
      } catch (error) {
        // Keep what this poll already processed; the failed item stays past the cursor.
        state.cursors[project.id] = cursor;
        failure = error;
        break outer;
      }
      added.push(
        ...detectNotifications({
          me,
          since,
          nameOf,
          activities: results(activities),
          comments: results(comments),
          item: {
            id: issue.id,
            key: `${project.identifier}-${issue.sequence_id}`,
            name: issue.name,
            url: `${client.instanceUrl}/${ws}/projects/${project.id}/issues/${issue.id}/`,
            assignees: issue.assignees ?? [],
            createdBy: issue.created_by,
          },
        }),
      );
      cursor = issue.updated_at;
    }
    // Oldest-first with a budget: anything skipped stays newer than the cursor for next time.
    state.cursors[project.id] = cursor;
  }

  const seen = await readJson<{ ids?: string[] }>(
    join(paths.inboxDir, "seen", `${PLUGIN_ID}.json`),
  );
  state.notifications = mergeNotifications(
    state.notifications,
    added,
    new Set(seen?.ids ?? []),
    now,
  );
  await writeJson(paths.statePath, state);
  await writeJson(join(paths.inboxDir, `${PLUGIN_ID}.json`), {
    version: 1,
    pluginId: PLUGIN_ID,
    itemId: "plane",
    title: "Plane",
    shortLabel: "PL",
    updatedAt: new Date(now).toISOString(),
    notifications: state.notifications,
  });
  // Progress and earlier notifications are saved; surface the failure to the caller's log.
  if (failure) throw failure;
  return added.length;
}

/** Polls while credentials exist; returns a stop function that also clears the inbox file. */
export function startNotifier(paths = defaultPaths(), intervalMs = POLL_MS): () => Promise<void> {
  let running = false;
  const tick = async () => {
    if (running) return;
    const credentials = resolveCredentials();
    if (!credentials) return;
    running = true;
    try {
      const client = createPlaneClient({
        token: credentials.token,
        instanceUrl: credentials.instanceUrl,
      });
      const added = await pollOnce(client, credentials.workspaceSlug, paths);
      if (added > 0) console.log(`plane-to-paseo: ${added} new notification(s)`);
    } catch (error) {
      console.error(
        `plane-to-paseo: notification poll failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return async () => {
    clearInterval(timer);
    await rm(join(paths.inboxDir, `${PLUGIN_ID}.json`), { force: true }).catch(() => undefined);
  };
}

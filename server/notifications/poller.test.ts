import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlaneClient } from "../plane/client";
import { mergeNotifications, type NotifierPaths, pollOnce } from "./poller";

let root: string;
let paths: NotifierPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plane-notify-"));
  paths = { inboxDir: join(root, "inbox"), statePath: join(root, "data", "state.json") };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

interface World {
  updatedAt: string;
  activities: unknown[];
}

function fakeClient(world: World, calls: string[]): PlaneClient {
  const routes: Record<string, () => unknown> = {
    "users/me/": () => ({ id: "me" }),
    "workspaces/aight/members/": () => [{ id: "sam", display_name: "sam.lee" }],
    "workspaces/aight/projects/": () => ({ results: [{ id: "p1", identifier: "PASEO" }] }),
    "workspaces/aight/projects/p1/issues/": () => ({
      results: [
        {
          id: "i1",
          name: "Split counts",
          sequence_id: 14,
          updated_at: world.updatedAt,
          assignees: ["me"],
          created_by: "me",
        },
      ],
    }),
    "workspaces/aight/projects/p1/issues/i1/activities/": () => ({ results: world.activities }),
    "workspaces/aight/projects/p1/issues/i1/comments/": () => ({ results: [] }),
  };
  return {
    instanceUrl: "https://plane.example",
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      const route = routes[path];
      if (!route) throw new Error(`unexpected ${path}`);
      return route() as T;
    },
    post: async () => {
      throw new Error("read-only");
    },
    patch: async () => {
      throw new Error("read-only");
    },
  };
}

function inbox() {
  return JSON.parse(readFileSync(join(paths.inboxDir, "plane-to-paseo.json"), "utf8"));
}

describe("pollOnce", () => {
  it("seeds silently, then publishes new events and honours the launcher's seen file", async () => {
    const calls: string[] = [];
    const world: World = { updatedAt: "2026-10-04T10:00:00Z", activities: [] };
    const client = fakeClient(world, calls);
    const now = Date.parse("2026-10-04T12:00:00Z");

    expect(await pollOnce(client, "aight", paths, now)).toBe(0);
    expect(inbox()).toMatchObject({
      pluginId: "plane-to-paseo",
      shortLabel: "PL",
      notifications: [],
    });
    expect(calls.some((c) => c.includes("/activities/"))).toBe(false);

    world.updatedAt = "2026-10-04T11:00:00Z";
    world.activities = [
      {
        id: "a1",
        verb: "updated",
        field: "state",
        old_value: "Todo",
        new_value: "Done",
        actor: "sam",
        created_at: "2026-10-04T11:00:00Z",
      },
    ];
    expect(await pollOnce(client, "aight", paths, now)).toBe(1);
    expect(inbox().notifications).toEqual([
      {
        id: "act:a1",
        title: "PASEO-14 Split counts",
        detail: "sam.lee moved it: Todo → Done",
        url: "https://plane.example/aight/projects/p1/issues/i1/",
        createdAt: "2026-10-04T11:00:00Z",
      },
    ]);

    // Unchanged item: no detail calls, notification persists until seen.
    calls.length = 0;
    expect(await pollOnce(client, "aight", paths, now)).toBe(0);
    expect(calls.some((c) => c.includes("/activities/"))).toBe(false);
    expect(inbox().notifications).toHaveLength(1);

    mkdirSync(join(paths.inboxDir, "seen"), { recursive: true });
    writeFileSync(
      join(paths.inboxDir, "seen", "plane-to-paseo.json"),
      JSON.stringify({ ids: ["act:a1"] }),
    );
    await pollOnce(client, "aight", paths, now);
    expect(inbox().notifications).toEqual([]);
  });
});

describe("mergeNotifications", () => {
  const n = (id: string, createdAt: string) => ({ id, title: id, detail: "", url: "", createdAt });

  it("dedupes, drops seen and expired, newest first", () => {
    const now = Date.parse("2026-10-20T00:00:00Z");
    const merged = mergeNotifications(
      [n("old", "2026-10-01T00:00:00Z"), n("a", "2026-10-18T00:00:00Z")],
      [
        n("a", "2026-10-18T00:00:00Z"),
        n("b", "2026-10-19T00:00:00Z"),
        n("seen", "2026-10-19T00:00:00Z"),
      ],
      new Set(["seen"]),
      now,
    );
    expect(merged.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("pollOnce failures", () => {
  it("saves progress made before a rate limit and retries the failed item next time", async () => {
    const calls: string[] = [];
    const world: World = { updatedAt: "2026-10-04T10:00:00Z", activities: [] };
    const client = fakeClient(world, calls);
    const now = Date.parse("2026-10-04T12:00:00Z");
    await pollOnce(client, "aight", paths, now);

    world.updatedAt = "2026-10-04T11:00:00Z";
    const failing: PlaneClient = {
      ...client,
      async get<T>(path: string): Promise<T> {
        if (path.endsWith("/comments/")) throw new Error("rate limited");
        return client.get<T>(path);
      },
    };
    await expect(pollOnce(failing, "aight", paths, now)).rejects.toThrow("rate limited");
    const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
    expect(state.cursors.p1).toBe("2026-10-04T10:00:00Z");

    calls.length = 0;
    await pollOnce(client, "aight", paths, now);
    expect(calls).toContain("workspaces/aight/projects/p1/issues/i1/comments/");
  });
});

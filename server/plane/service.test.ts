import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createPlaneClient } from "./client";
import { branchNameFor, firstStartedState, PlaneService, textToCommentHtml } from "./service";
import { type CapturedRequest, json, withHttpServer } from "./test-server";

const TOKEN = "plane_api_test_token";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WS = "/api/v1/workspaces/acme";

const projects = [
  { id: "p-ops", identifier: "OPS", name: "Operations" },
  { id: "p-app", identifier: "APP", name: "App" },
  { id: "p-old", identifier: "OLD", name: "Archived", archived_at: "2026-01-01T00:00:00Z" },
];
const states = [
  { id: "s-backlog", name: "Backlog", group: "backlog", color: "#999", sequence: 1000 },
  { id: "s-todo", name: "Todo", group: "unstarted", color: "#ccc", sequence: 2000 },
  { id: "s-review", name: "In Review", group: "started", color: "#fa0", sequence: 4000 },
  { id: "s-doing", name: "In Progress", group: "started", color: "#f80", sequence: 3000 },
  { id: "s-done", name: "Done", group: "completed", color: "#0a0", sequence: 5000 },
  { id: "s-cancel", name: "Cancelled", group: "cancelled", color: "#a00", sequence: 6000 },
];
const labels = [{ id: "l-bug", name: "Bug", color: "#f00" }];
const viewer = {
  id: "u-me",
  first_name: "Gordon",
  last_name: "Lee",
  display_name: "gordon",
  email: "g@acme.test",
  avatar_url: null,
};
const members = [
  viewer,
  { id: "u-ada", first_name: "Ada", last_name: "", display_name: "ada", email: "a@acme.test" },
];

function workItem(project: string, n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `${project}-wi-${n}`,
    name: `Item ${n}`,
    sequence_id: n,
    project: project,
    state: "s-todo",
    priority: "medium",
    assignees: [],
    labels: ["l-bug"],
    description_html: `<p>Description ${n}</p>`,
    target_date: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: `2026-01-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
    completed_at: null,
    parent: null,
    created_by: "u-ada",
    // Live Plane expands a missing estimate to an object with an empty value.
    estimate_point: { value: "", key: null },
    ...extra,
  };
}

const items: Record<string, ReturnType<typeof workItem>[]> = {
  "p-ops": [
    workItem("p-ops", 1, {
      assignees: ["u-me", "u-ada"],
      priority: "urgent",
      estimate_point: { value: "2", key: 2 },
    }),
    workItem("p-ops", 2, { state: "s-done" }),
  ],
  "p-app": [
    workItem("p-app", 3, {
      priority: "none",
      parent: "p-ops-wi-1",
      description_html:
        '<p>See <mention-component entity_identifier="u-ada"></mention-component></p><image-component src="asset-1"></image-component>',
    }),
  ],
};

function page(results: unknown[]) {
  return { results, next_cursor: "100:1:0", next_page_results: false, total_count: results.length };
}

function planeFake(
  origin: () => string,
  extra?: (r: CapturedRequest, res: ServerResponse) => boolean,
) {
  return (request: CapturedRequest, response: ServerResponse) => {
    if (extra?.(request, response)) return;
    if (request.apiKey !== TOKEN && request.url.startsWith("/api/")) {
      return json(response, 401, { detail: "Invalid token" });
    }
    const url = new URL(request.url, "http://x");
    const path = url.pathname;
    if (path === "/api/v1/users/me/") return json(response, 200, viewer);
    if (path === "/api/v1/users/me/sprint-capacity/people/")
      return json(response, 200, [
        { id: "u-ana", display_name: "ana", first_name: "Ana", last_name: "Ng", is_me: false },
        { id: viewer.id, display_name: "me", first_name: "Me", last_name: "", is_me: true },
      ]);
    if (path === "/api/v1/users/me/sprint-capacity/" && url.searchParams.get("user_id") === "u-ana")
      return json(response, 200, {
        sprints: [
          {
            label: "Oct 5 – Oct 11",
            start_date: "2026-10-05",
            end_date: "2026-10-11",
            is_current: true,
            items: [{ id: "p-ops-wi-2" }],
          },
        ],
      });
    if (path === "/api/v1/users/me/sprint-capacity/")
      return json(response, 200, {
        capacity: 8,
        buffer_capacity: 2,
        sprints: [
          {
            label: "Sep 28 – Oct 4",
            start_date: "2026-09-28",
            end_date: "2026-10-04",
            is_current: false,
            items: [],
          },
          {
            label: "Oct 5 – Oct 11",
            start_date: "2026-10-05",
            end_date: "2026-10-11",
            is_current: true,
            planned_points: 5,
            buffer_points: 1,
            done_points: 3,
            unestimated: 1,
            items: [
              { id: "p-ops-wi-1", name: "Item 1", project_identifier: "OPS", sequence_id: 1 },
            ],
          },
        ],
      });
    if (path === `${WS}/members/`) return json(response, 200, members);
    if (path === `${WS}/projects/`) return json(response, 200, page(projects));
    if (path === `${WS}/work-items/search/`) {
      const term = url.searchParams.get("search") ?? "";
      const hits = Object.values(items)
        .flat()
        .filter((item) => item.name.toLowerCase().includes(term.toLowerCase()))
        .map((item) => ({
          id: item.id,
          name: item.name,
          project_id: item.project,
          sequence_id: item.sequence_id,
        }));
      return json(response, 200, { issues: hits });
    }
    const byKey = path.match(/^\/api\/v1\/workspaces\/acme\/work-items\/([A-Z]+)-(\d+)\/$/);
    if (byKey) {
      const project = projects.find((p) => p.identifier === byKey[1]);
      const found = project && items[project.id]?.find((i) => i.sequence_id === Number(byKey[2]));
      return found ? json(response, 200, found) : json(response, 404, { error: "Issue not found" });
    }
    const asset = path.match(/^\/api\/v1\/workspaces\/acme\/assets\/([\w-]+)\/$/);
    if (asset) {
      // Plane behind a TLS proxy signs an http URL for its own host.
      return json(response, 200, {
        asset_url: `${origin()}/uploads/${asset[1]}.png?X-Amz-Signature=abc`,
        asset_name: "x.png",
      });
    }
    const project = path.match(/^\/api\/v1\/workspaces\/acme\/projects\/([\w-]+)\/(.*)$/);
    if (project) {
      const [, pid = "", rest = ""] = project;
      if (rest === "states/") return json(response, 200, page(states));
      if (rest === "labels/") return json(response, 200, page(labels));
      if (rest === "members/")
        return json(response, 200, [
          ...members,
          {
            id: "u-bot",
            first_name: "",
            display_name: "bot_user_1",
            email: "bot_user_1@plane.test",
          },
        ]);
      if (rest === "work-items/") return json(response, 200, page(items[pid] ?? []));
      const wi = rest.match(/^work-items\/([\w-]+)\/(.*)$/);
      if (wi) {
        const [, id, sub] = wi;
        const item = items[pid]?.find((i) => i.id === id);
        if (!item) return json(response, 404, { error: "not found" });
        if (sub === "" && request.method === "GET") {
          if (
            (url.searchParams.get("expand") ?? "").split(",").includes("parent") &&
            !item.parent
          ) {
            // Live Plane serialises a missing parent as {} under expand.
            return json(response, 200, { ...item, parent: {} });
          }
          if ((url.searchParams.get("expand") ?? "").split(",").includes("parent") && item.parent) {
            const parent = Object.values(items)
              .flat()
              .find((i) => i.id === item.parent);
            return json(response, 200, {
              ...item,
              parent: {
                id: item.parent,
                sequence_id: parent?.sequence_id,
                project_id: parent?.project,
              },
            });
          }
          return json(response, 200, item);
        }
        if (sub === "" && request.method === "PATCH")
          return json(response, 200, { ...item, ...request.body });
        if (sub === "comments/" && request.method === "POST")
          return json(response, 201, { id: "c-new" });
        if (sub === "comments/")
          return json(
            response,
            200,
            page([
              {
                id: "c2",
                comment_html: "<p>Second</p>",
                created_at: "2026-01-03T00:00:00Z",
                actor: "u-me",
              },
              {
                id: "c1",
                comment_html: '<p>First <img src="https://cdn.example/uploads/shot.png"></p>',
                created_at: "2026-01-02T00:00:00Z",
                actor: "u-ada",
              },
            ]),
          );
        if (sub === "links/")
          return json(
            response,
            200,
            page([{ id: "k1", title: "Spec", url: "https://docs.example/spec" }]),
          );
        if (sub === "attachments/")
          return json(response, 200, [
            { id: "att-img", attributes: { name: "screen.png", type: "image/png", size: 10 } },
            { id: "att-pdf", attributes: { name: "brief.pdf", type: "application/pdf", size: 10 } },
          ]);
      }
    }
    if (path.startsWith("/uploads/")) {
      if (request.apiKey)
        return json(response, 400, { error: "presigned URLs must not carry the key" });
      response.writeHead(200, { "Content-Type": "image/png" });
      return response.end(PNG);
    }
    json(response, 404, { error: `unhandled ${request.method} ${path}` });
  };
}

async function withService<T>(
  run: (service: PlaneService, requests: CapturedRequest[], origin: string) => Promise<T>,
  extra?: (r: CapturedRequest, res: ServerResponse) => boolean,
) {
  let origin = "";
  return withHttpServer(
    planeFake(() => origin, extra),
    async (o, requests) => {
      origin = o;
      const fetchImpl: typeof fetch = async (input, init) => {
        // Route the fake CDN through the same server.
        const url = String(input).replace("https://cdn.example", origin);
        return fetch(url, init);
      };
      const service = new PlaneService({
        client: createPlaneClient({ token: TOKEN, instanceUrl: origin, fetchImpl }),
        workspaceSlug: "acme",
        fetchImpl,
      });
      return run(service, requests, origin);
    },
  );
}

describe("PlaneService.listIssues", () => {
  it("fans out across active projects and maps Plane fields", async () => {
    await withService(async (service, requests, origin) => {
      const result = await service.listIssues({ includeClosed: false, refresh: false });
      expect(result.projects.map((p) => p.key)).toEqual(["APP", "OPS"]);
      expect(result.viewer).toEqual({ id: "u-me", name: "Gordon Lee" });
      expect(result.truncated).toBe(false);
      expect(result.issues.map((i) => i.identifier)).toEqual(["APP-3", "OPS-1"]);

      const ops1 = result.issues.find((i) => i.identifier === "OPS-1");
      expect(ops1).toMatchObject({
        title: "Item 1",
        url: `${origin}/acme/browse/OPS-1/`,
        branchName: "ops-1-item-1",
        priority: 1,
        priorityLabel: "Urgent",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        project: { id: "p-ops", key: "OPS", name: "Operations" },
        labels: [{ id: "l-bug", name: "Bug", color: "#f00" }],
        descriptionPreview: "Description 1",
      });
      expect(ops1?.assignees.map((u) => u.name)).toEqual(["Gordon Lee", "Ada"]);
      expect(result.issues.find((i) => i.identifier === "APP-3")?.priorityLabel).toBe(
        "No priority",
      );
      expect(ops1?.estimate).toBe("2");
      expect(result.issues.find((i) => i.identifier === "APP-3")?.estimate).toBeNull();
      const list = requests.find((r) => r.url.includes("/projects/p-ops/work-items/?"));
      expect(list?.url).toContain("expand=estimate_point");

      expect(requests.some((r) => r.url.includes("p-old"))).toBe(false);
      expect(requests.every((r) => r.apiKey === TOKEN)).toBe(true);
    });
  });

  it("includes closed work items on request and caches per scope", async () => {
    await withService(async (service, requests) => {
      const all = await service.listIssues({ includeClosed: true, refresh: false });
      expect(all.issues.map((i) => i.identifier)).toContain("OPS-2");
      const before = requests.length;
      await service.listIssues({ includeClosed: true, refresh: false });
      expect(requests.length).toBe(before);
      await service.listIssues({ includeClosed: true, refresh: true });
      expect(requests.length).toBeGreaterThan(before);
    });
  });
});

describe("PlaneService.searchIssues", () => {
  it("resolves an exact identifier directly", async () => {
    await withService(async (service, requests) => {
      const result = await service.searchIssues("ops-1");
      expect(result.map((i) => i.identifier)).toEqual(["OPS-1"]);
      expect(requests.some((r) => r.url.includes("/work-items/OPS-1/"))).toBe(true);
      expect(requests.some((r) => r.url.includes("/search/"))).toBe(false);
    });
  });

  it("falls back to workspace search and hydrates hits", async () => {
    await withService(async (service, requests) => {
      const result = await service.searchIssues("item 3");
      expect(result.map((i) => i.identifier)).toEqual(["APP-3"]);
      const search = requests.find((r) => r.url.includes("/search/"));
      expect(search?.url).toContain("workspace_search=true");
    });
  });

  it("returns nothing for an unknown identifier with no title match", async () => {
    await withService(async (service) => {
      expect(await service.searchIssues("ZZZ-9")).toEqual([]);
    });
  });
});

describe("PlaneService.issueDetail", () => {
  it("converts HTML, orders comments, resolves parent, links, attachments, and images", async () => {
    await withService(async (service, requests, origin) => {
      const detail = await service.issueDetail({ issueId: "p-app-wi-3", projectId: "p-app" });
      const assetUrl = `${origin}/api/v1/workspaces/acme/assets/asset-1/`;
      expect(detail.description).toBe(`See @Ada\n\n![](${assetUrl})`);
      expect(detail.comments.map((c) => [c.id, c.user?.name, c.body])).toEqual([
        ["c1", "Ada", `First ![](https://cdn.example/uploads/shot.png)`],
        ["c2", "Gordon Lee", "Second"],
      ]);
      expect(detail.commentCount).toBe(2);
      expect(detail.creator?.name).toBe("Ada");
      expect(detail.parent).toEqual({
        identifier: "OPS-1",
        title: "Item 1",
        url: `${origin}/acme/browse/OPS-1/`,
      });
      expect(detail.attachments).toEqual([
        { id: "k1", title: "Spec", url: "https://docs.example/spec", sourceType: "link" },
        { id: "att-img", title: "screen.png", url: detail.url, sourceType: "image/png" },
        { id: "att-pdf", title: "brief.pdf", url: detail.url, sourceType: "application/pdf" },
      ]);
      expect(detail.images.map((i) => [i.source, i.mimeType, i.error, Boolean(i.data)])).toEqual([
        ["description", "image/png", null, true],
        ["comment", "image/png", null, true],
        ["attachment", "image/png", null, true],
      ]);
      expect(detail.images[0]?.data).toBe(PNG.toString("base64"));
      // The key goes to the API only, never to the presigned upload URLs.
      expect(requests.filter((r) => r.url.startsWith("/uploads/")).every((r) => !r.apiKey)).toBe(
        true,
      );
    });
  });

  it("treats an expanded empty parent as no parent", async () => {
    await withService(async (service) => {
      const detail = await service.issueDetail({ issueId: "p-ops-wi-1", projectId: "p-ops" });
      expect(detail.parent).toBeNull();
      expect(detail.identifier).toBe("OPS-1");
    });
  });

  it("keeps the detail when an image fails", async () => {
    await withService(
      async (service) => {
        const detail = await service.issueDetail({ issueId: "p-app-wi-3", projectId: "p-app" });
        expect(detail.images[0]?.error).toMatch(/HTTP 403|Not found|lacks permission/);
        expect(detail.images[0]?.data).toBeNull();
      },
      (request, response) => {
        if (request.url.includes("/assets/asset-1/")) {
          json(response, 403, { detail: "no" });
          return true;
        }
        return false;
      },
    );
  });
});

describe("PlaneService.startIssue", () => {
  it("moves to the first started state, adds the viewer to assignees, and comments", async () => {
    await withService(async (service, requests) => {
      const result = await service.startIssue({
        issueId: "p-app-wi-3",
        projectId: "p-app",
        moveToStarted: true,
        assignToMe: true,
        comment: "Started in Paseo <now>\n\nworktree: x",
      });
      expect(result).toEqual({ moved: true, assigned: true, commented: true, warnings: [] });
      const patch = requests.find((r) => r.method === "PATCH");
      expect(patch?.body).toEqual({ state: "s-doing", assignees: ["u-me"] });
      const post = requests.find((r) => r.method === "POST");
      expect(post?.body).toEqual({
        comment_html: "<p>Started in Paseo &lt;now&gt;</p><p>worktree: x</p>",
      });
    });
  });

  it("keeps existing assignees and does not move already-started or finished work", async () => {
    await withService(async (service, requests) => {
      const result = await service.startIssue({
        issueId: "p-ops-wi-2",
        projectId: "p-ops",
        moveToStarted: true,
        assignToMe: true,
        comment: "",
      });
      expect(result).toEqual({ moved: false, assigned: true, commented: false, warnings: [] });
      expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ assignees: ["u-me"] });
    });
    await withService(async (service, requests) => {
      const result = await service.startIssue({
        issueId: "p-ops-wi-1",
        projectId: "p-ops",
        moveToStarted: false,
        assignToMe: true,
        comment: "",
      });
      expect(result.assigned).toBe(false);
      expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    });
  });

  it("reports update failures as warnings", async () => {
    await withService(
      async (service) => {
        const result = await service.startIssue({
          issueId: "p-app-wi-3",
          projectId: "p-app",
          moveToStarted: true,
          assignToMe: false,
          comment: "",
        });
        expect(result.moved).toBe(false);
        expect(result.warnings[0]).toMatch(/Work item update failed: .*lacks permission/);
      },
      (request, response) => {
        if (request.method === "PATCH") {
          json(response, 403, { detail: "Forbidden" });
          return true;
        }
        return false;
      },
    );
  });
});

describe("PlaneService assignees", () => {
  it("lists project members without the workspace bot", async () => {
    await withService(async (service) => {
      const result = await service.projectMembers("p-app");
      expect(result.map((user) => user.name)).toEqual(["Ada", "Gordon Lee"]);
    });
  });

  it("replaces the whole assignee list and maps the result", async () => {
    await withService(async (service, requests) => {
      await service.listIssues({ includeClosed: false, refresh: false });
      const result = await service.setAssignees({
        issueId: "p-ops-wi-1",
        projectId: "p-ops",
        assigneeIds: ["u-ada", "u-ada"],
      });
      expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ assignees: ["u-ada"] });
      expect(result.assignees.map((user) => user.name)).toEqual(["Ada"]);
      // Caches are dropped so the next list reflects the change.
      const before = requests.length;
      await service.listIssues({ includeClosed: false, refresh: false });
      expect(requests.length).toBeGreaterThan(before);
    });
  });

  it("can unassign everyone", async () => {
    await withService(async (service, requests) => {
      const result = await service.setAssignees({
        issueId: "p-ops-wi-1",
        projectId: "p-ops",
        assigneeIds: [],
      });
      expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ assignees: [] });
      expect(result.assignees).toEqual([]);
    });
  });
});

describe("PlaneService states", () => {
  it("lists project states by group, then sequence", async () => {
    await withService(async (service) => {
      const states = await service.projectStates("p-app");
      expect(states.map((state) => state.name)).toEqual([
        "Backlog",
        "Todo",
        "In Progress",
        "In Review",
        "Done",
        "Cancelled",
      ]);
      expect(states[2]).toEqual({
        id: "s-doing",
        name: "In Progress",
        type: "started",
        color: "#f80",
        position: 3000,
      });
    });
  });

  it("moves a work item and returns the new state", async () => {
    await withService(async (service, requests) => {
      const result = await service.setState({
        issueId: "p-app-wi-3",
        projectId: "p-app",
        stateId: "s-review",
      });
      expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ state: "s-review" });
      expect(result.state).toMatchObject({ id: "s-review", name: "In Review", type: "started" });
    });
  });

  it("refuses a state from outside the project without calling Plane", async () => {
    await withService(async (service, requests) => {
      await expect(
        service.setState({ issueId: "p-app-wi-3", projectId: "p-app", stateId: "s-elsewhere" }),
      ).rejects.toThrow(/does not belong to this project/);
      expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    });
  });
});

describe("PlaneService.mySprints", () => {
  it("returns every sprint with its item ids, oldest first", async () => {
    await withService(async (service) => {
      const sprints = await service.mySprints();
      expect(sprints.map((s) => [s.startDate, s.isCurrent, s.issueIds])).toEqual([
        ["2026-09-28", false, []],
        ["2026-10-05", true, ["p-ops-wi-1"]],
      ]);
    });
  });

  it("carries points against capacity, defaulting to zero when absent", async () => {
    await withService(async (service) => {
      const [past, current] = await service.mySprints();
      expect(current).toMatchObject({
        plannedPoints: 5,
        bufferPoints: 1,
        donePoints: 3,
        capacity: 8,
        bufferCapacity: 2,
        unestimated: 1,
      });
      expect(past).toMatchObject({ plannedPoints: 0, bufferPoints: 0, capacity: 8 });
    });
  });

  it("asks for four past weeks, this week and next", async () => {
    await withService(async (service, requests) => {
      await service.mySprints();
      const call = requests.find((r) => r.url.includes("sprint-capacity"));
      expect(new URL(call?.url ?? "", "http://x").searchParams.get("offsets")).toBe(
        "-4,-3,-2,-1,0,1",
      );
    });
  });

  it("reads a teammate's sprint with user_id, cached apart from the viewer's", async () => {
    await withService(async (service) => {
      expect((await service.mySprints("u-ana"))[0]?.issueIds).toEqual(["p-ops-wi-2"]);
      expect((await service.mySprints())[1]?.issueIds).toEqual(["p-ops-wi-1"]);
    });
  });

  it("lists sprint people with the viewer first", async () => {
    await withService(async (service) => {
      expect(await service.sprintPeople()).toEqual([
        { id: viewer.id, name: "Me", isMe: true },
        { id: "u-ana", name: "Ana Ng", isMe: false },
      ]);
    });
  });

  it("has no sprint people on Plane builds without the endpoint", async () => {
    await withService(
      async (service) => {
        expect(await service.sprintPeople()).toEqual([]);
      },
      (request, response) => {
        if (request.url.includes("sprint-capacity")) {
          json(response, 404, { detail: "Not found." });
          return true;
        }
        return false;
      },
    );
  });

  it("is empty on Plane builds without the endpoint", async () => {
    await withService(
      async (service) => {
        expect(await service.mySprints()).toEqual([]);
      },
      (request, response) => {
        if (request.url.includes("sprint-capacity")) {
          json(response, 404, { detail: "Not found." });
          return true;
        }
        return false;
      },
    );
  });
});

describe("helpers", () => {
  it("picks the lowest-sequence started state", () => {
    expect(firstStartedState(states)?.id).toBe("s-doing");
    expect(firstStartedState(states.filter((s) => s.group !== "started"))).toBeNull();
  });

  it("builds branch names", () => {
    expect(branchNameFor("ENG-42", "Fix: iOS launch crash (Sentry DSN)!")).toBe(
      "eng-42-fix-ios-launch-crash-sentry-dsn",
    );
    expect(branchNameFor("OPS-1", "日本語")).toBe("ops-1");
  });

  it("escapes comment text into paragraphs", () => {
    expect(textToCommentHtml("a & b\nc\n\n<d>")).toBe("<p>a &amp; b<br>c</p><p>&lt;d&gt;</p>");
  });

  it("renders the hand-off comment's bold and code", () => {
    expect(textToCommentHtml("In **g0rdonL/skills** on `ops-2-x` (agent `a<1>`). 2 ** 3")).toBe(
      "<p>In <strong>g0rdonL/skills</strong> on <code>ops-2-x</code> (agent <code>a&lt;1&gt;</code>). 2 ** 3</p>",
    );
  });
});

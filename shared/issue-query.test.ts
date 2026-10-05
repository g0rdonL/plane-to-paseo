import { describe, expect, it } from "vitest";
import type { Issue } from "./contracts";
import {
  applyFilters,
  countActiveFilters,
  deriveFacets,
  EMPTY_FILTERS,
  type IssueFilters,
  NO_ESTIMATE,
  queryIssues,
  searchIssues,
  sortIssues,
} from "./issue-query";

function issue(overrides: Partial<Issue> & { identifier: string }): Issue {
  const [key = "ENG"] = overrides.identifier.split("-");
  return {
    id: `id-${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    url: `https://plane.example/acme/browse/${overrides.identifier}/`,
    branchName: `me/${overrides.identifier.toLowerCase()}`,
    priority: 0,
    priorityLabel: "No priority",
    estimate: null,
    dueDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    state: { id: "todo", name: "Todo", type: "unstarted", color: null, position: 1 },
    project: { id: `project-${key}`, key, name: `Project ${key}` },
    assignees: [],
    labels: [],
    commentCount: null,
    descriptionPreview: null,
    ...overrides,
  };
}

const done = { id: "done", name: "Done", type: "completed", color: null, position: 5 };
const inProgress = { id: "wip", name: "In Progress", type: "started", color: "#f00", position: 2 };

const issues: Issue[] = [
  issue({
    identifier: "ENG-1",
    priority: 3,
    updatedAt: "2026-02-01T00:00:00.000Z",
    title: "Fix login bug",
  }),
  issue({
    identifier: "ENG-2",
    priority: 1,
    updatedAt: "2026-01-15T00:00:00.000Z",
    assignees: [{ id: "me", name: "Me", displayName: "me", avatarUrl: null }],
    labels: [{ id: "bug", name: "Bug", color: null }],
    state: inProgress,
    dueDate: "2026-03-01",
  }),
  issue({ identifier: "ENG-10", priority: 0, updatedAt: "2026-02-10T00:00:00.000Z", state: done }),
  issue({
    identifier: "OPS-4",
    priority: 2,
    descriptionPreview: "Rotate the TLS certificates",
    dueDate: "2026-02-01",
    createdAt: "2026-02-05T00:00:00.000Z",
  }),
];

describe("sortIssues", () => {
  it("puts urgent first and no-priority last, tie-breaking by recency", () => {
    expect(sortIssues(issues, "priority").map((i) => i.identifier)).toEqual([
      "ENG-2",
      "OPS-4",
      "ENG-1",
      "ENG-10",
    ]);
  });

  it("sorts identifiers numerically within a team", () => {
    expect(sortIssues(issues, "identifier").map((i) => i.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
      "ENG-10",
      "OPS-4",
    ]);
  });

  it("sorts due dates ascending with undated issues last", () => {
    expect(sortIssues(issues, "due").map((i) => i.identifier)).toEqual([
      "OPS-4",
      "ENG-2",
      "ENG-10",
      "ENG-1",
    ]);
  });

  it("sorts by created and updated descending", () => {
    expect(sortIssues(issues, "created")[0]?.identifier).toBe("OPS-4");
    expect(sortIssues(issues, "updated")[0]?.identifier).toBe("ENG-10");
  });
});

describe("applyFilters", () => {
  it("hides closed issues unless asked", () => {
    expect(applyFilters(issues, EMPTY_FILTERS, null).map((i) => i.identifier)).not.toContain(
      "ENG-10",
    );
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, includeClosed: true }, null).map(
        (i) => i.identifier,
      ),
    ).toContain("ENG-10");
  });

  it("combines facets with AND and state ids/types with OR", () => {
    const filtered = applyFilters(
      issues,
      {
        ...EMPTY_FILTERS,
        projectIds: ["project-ENG"],
        stateTypes: ["started"],
        stateIds: ["todo"],
      },
      null,
    );
    expect(filtered.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("filters by assignee mode and by viewer", () => {
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, assignee: "me" }, "me").map((i) => i.identifier),
    ).toEqual(["ENG-2"]);
    expect(applyFilters(issues, { ...EMPTY_FILTERS, assignee: "me" }, null)).toEqual([]);
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, assignee: "unassigned" }, "me").map(
        (i) => i.identifier,
      ),
    ).toEqual(["ENG-1", "OPS-4"]);
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, assigneeIds: ["me"] }, null).map(
        (i) => i.identifier,
      ),
    ).toEqual(["ENG-2"]);
  });

  it("'mine or unassigned' keeps my issues and unassigned ones, only unassigned without a viewer", () => {
    const withOther = [
      ...issues,
      issue({
        identifier: "ENG-3",
        assignees: [{ id: "other", name: "Other", displayName: null, avatarUrl: null }],
      }),
      issue({
        identifier: "ENG-4",
        assignees: [
          { id: "other", name: "Other", displayName: null, avatarUrl: null },
          { id: "me", name: "Me", displayName: "me", avatarUrl: null },
        ],
      }),
    ];
    const scope = { ...EMPTY_FILTERS, assignee: "me-or-unassigned" as const };
    // ENG-4 is shared with someone else; being any one of its assignees counts as mine.
    expect(applyFilters(withOther, scope, "me").map((i) => i.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
      "OPS-4",
      "ENG-4",
    ]);
    expect(applyFilters(withOther, scope, null).map((i) => i.identifier)).toEqual([
      "ENG-1",
      "OPS-4",
    ]);
  });

  it("filters by priority, label, and project", () => {
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, priorities: [1, 2] }, null).map((i) => i.identifier),
    ).toEqual(["ENG-2", "OPS-4"]);
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, labelIds: ["bug"] }, null).map((i) => i.identifier),
    ).toEqual(["ENG-2"]);
    expect(
      applyFilters(issues, { ...EMPTY_FILTERS, projectIds: ["project-OPS"] }, null).map(
        (i) => i.identifier,
      ),
    ).toEqual(["OPS-4"]);
  });

  it("narrows to the picked sprint once its ids are known", () => {
    const sprint = new Set(["id-ENG-2", "id-OPS-4"]);
    const scope = { ...EMPTY_FILTERS, sprint: "2026-10-05" };
    expect(applyFilters(issues, scope, null, sprint).map((i) => i.identifier)).toEqual([
      "ENG-2",
      "OPS-4",
    ]);
    // Until the sprint loads (or on Plane without the endpoint) the toggle filters nothing.
    expect(applyFilters(issues, scope, null)).toHaveLength(3);
    expect(
      queryIssues(
        issues,
        { filters: scope, search: "", sort: "updated", sprintIds: sprint },
        null,
      ).map((i) => i.identifier),
    ).toEqual(["ENG-2", "OPS-4"]);
    expect(countActiveFilters(scope)).toBe(1);
  });

  it("counts active filter groups", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(
      countActiveFilters({ ...EMPTY_FILTERS, projectIds: ["p"], stateIds: ["s"], assignee: "me" }),
    ).toBe(3);
  });
});

describe("searchIssues", () => {
  it("matches every token across identifier, title, labels and description", () => {
    expect(searchIssues(issues, "login fix").map((i) => i.identifier)).toEqual(["ENG-1"]);
    expect(searchIssues(issues, "bug").map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(searchIssues(issues, "tls").map((i) => i.identifier)).toEqual(["OPS-4"]);
    expect(searchIssues(issues, "nothing here")).toEqual([]);
  });

  it("ranks an exact identifier first and is case-insensitive", () => {
    expect(searchIssues(issues, "eng-1").map((i) => i.identifier)).toEqual(["ENG-1", "ENG-10"]);
  });

  it("returns everything for a blank query", () => {
    expect(searchIssues(issues, "   ")).toHaveLength(4);
  });
});

describe("queryIssues", () => {
  it("filters, then searches, then sorts, keeping an exact identifier hit on top", () => {
    // "ENG-1" matches ENG-1 exactly and ENG-10 by substring; ENG-10 is more recently updated,
    // so the exact hit must be pinned first despite the sort order.
    const result = queryIssues(
      issues,
      { filters: { ...EMPTY_FILTERS, includeClosed: true }, search: "ENG-1", sort: "updated" },
      null,
    );
    expect(result.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-10"]);
    expect(
      queryIssues(issues, { filters: EMPTY_FILTERS, search: "ENG-1", sort: "updated" }, null).map(
        (i) => i.identifier,
      ),
    ).toEqual(["ENG-1"]);
  });

  it("lists the viewer's issues first when mineFirst is set, after the exact identifier pin", () => {
    const query = { filters: EMPTY_FILTERS, search: "", sort: "updated" as const, mineFirst: true };
    // By updatedAt: ENG-1 (Feb 1), ENG-2 (Jan 15), OPS-4 (Jan 1). ENG-2 is mine, so it moves to the top.
    expect(queryIssues(issues, query, "me").map((i) => i.identifier)).toEqual([
      "ENG-2",
      "ENG-1",
      "OPS-4",
    ]);
    expect(queryIssues(issues, query, null)[0]?.identifier).toBe("ENG-1");
    expect(
      queryIssues(issues, { ...query, search: "ENG-1" }, "me").map((i) => i.identifier),
    ).toEqual(["ENG-1"]);
  });
});

describe("deriveFacets", () => {
  it("collects distinct values with counts", () => {
    const facets = deriveFacets(issues);
    expect(facets.projects.map((f) => [f.value.key, f.count])).toEqual([
      ["ENG", 3],
      ["OPS", 1],
    ]);
    expect(facets.states.map((s) => s.name)).toEqual(["Todo", "In Progress", "Done"]);
    expect(facets.labels[0]).toMatchObject({ count: 1, value: { name: "Bug" } });
    expect(facets.assignees[0]?.value.id).toBe("me");
    expect(facets.priorities.map((f) => f.value)).toEqual([1, 2, 3, 0]);
  });
});

describe("due, estimate and creator filters", () => {
  const now = new Date(2026, 9, 4, 15, 0); // Oct 4, local time
  const list = [
    issue({ identifier: "A-1", dueDate: "2026-10-01", estimate: "2", createdById: "me" }),
    issue({ identifier: "A-2", dueDate: "2026-10-04", estimate: "XS" }),
    issue({ identifier: "A-3", dueDate: "2026-10-09", estimate: null, createdById: "me" }),
    issue({ identifier: "A-4", dueDate: "2026-10-20", estimate: "" }),
    issue({ identifier: "A-5", dueDate: null, estimate: "8" }),
  ];
  const ids = (filters: Partial<IssueFilters>, viewer: string | null = "me") =>
    applyFilters(list, { ...EMPTY_FILTERS, ...filters }, viewer, null, now).map(
      (i) => i.identifier,
    );

  it("filters by due date relative to today", () => {
    expect(ids({ due: "overdue" })).toEqual(["A-1"]);
    expect(ids({ due: "today" })).toEqual(["A-1", "A-2"]);
    expect(ids({ due: "week" })).toEqual(["A-1", "A-2", "A-3"]);
    expect(ids({ due: "none" })).toEqual(["A-5"]);
  });

  it("filters by estimate, treating missing and empty alike", () => {
    expect(ids({ estimates: ["2", "8"] })).toEqual(["A-1", "A-5"]);
    expect(ids({ estimates: [NO_ESTIMATE] })).toEqual(["A-3", "A-4"]);
  });

  it("matches only the viewer's own items, and nothing without a viewer", () => {
    expect(ids({ createdByMe: true })).toEqual(["A-1", "A-3"]);
    expect(ids({ createdByMe: true }, null)).toEqual([]);
  });

  it("counts each new filter once", () => {
    expect(
      countActiveFilters({ ...EMPTY_FILTERS, due: "overdue", estimates: ["2"], createdByMe: true }),
    ).toBe(3);
  });

  it("orders estimate facets numbers, then sizes, with no estimate last", () => {
    const values = deriveFacets([
      ...list,
      issue({ identifier: "A-6", estimate: "L" }),
      issue({ identifier: "A-7", estimate: "13" }),
    ]).estimates.map((f) => f.value);
    expect(values).toEqual(["2", "8", "13", "XS", "L", NO_ESTIMATE]);
  });
});

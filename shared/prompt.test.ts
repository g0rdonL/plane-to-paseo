import { describe, expect, it } from "vitest";
import type { IssueDetail } from "./contracts";
import {
  DEFAULT_PROMPT_TEMPLATE,
  hydratePrompt,
  issueSummaryText,
  orderComments,
  ticketText,
} from "./prompt";

const detail: IssueDetail = {
  id: "issue-1",
  identifier: "ENG-42",
  title: "Broken avatar upload",
  url: "https://plane.example/acme/browse/ENG-42/",
  branchName: "eng-42-broken-avatar-upload",
  priority: 2,
  priorityLabel: "High",
  estimate: "3",
  dueDate: "2026-09-30",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-05T10:00:00.000Z",
  completedAt: null,
  state: { id: "todo", name: "Todo", type: "unstarted", color: null, position: 1 },
  project: { id: "p", key: "ENG", name: "Engineering" },
  assignees: [
    { id: "u1", name: "Sam", displayName: "sam", avatarUrl: null },
    { id: "u2", name: "Kim", displayName: null, avatarUrl: null },
  ],
  labels: [{ id: "l1", name: "Bug", color: null }],
  commentCount: 3,
  descriptionPreview: "Uploads over 2 MB fail.",
  description:
    "Uploads over 2 MB fail.\n\n![screenshot](https://plane.example/api/v1/workspaces/acme/assets/shot.png)\n\nSee also ![ext](https://example.com/x.png).",
  creator: null,
  cycle: { id: "c", name: "Sprint 12" },
  parent: null,
  comments: [
    {
      id: "c2",
      body: "Reply to first",
      createdAt: "2026-09-03T00:00:00.000Z",
      user: { id: "u2", name: "Kim", displayName: null, avatarUrl: null },
    },
    {
      id: "c1",
      body: "First comment\nwith two lines",
      createdAt: "2026-09-02T00:00:00.000Z",
      user: { id: "u1", name: "Sam", displayName: "sam", avatarUrl: null },
    },
    {
      id: "c3",
      body: "Later ![log](https://plane.example/api/v1/workspaces/acme/assets/log.png)",
      createdAt: "2026-09-04T00:00:00.000Z",
      user: null,
    },
  ],
  attachments: [
    { id: "a1", title: "PR #12", url: "https://github.com/acme/app/pull/12", sourceType: "github" },
  ],
  images: [
    {
      url: "https://plane.example/api/v1/workspaces/acme/assets/shot.png",
      alt: "screenshot",
      source: "description",
      commentId: null,
      mimeType: "image/png",
      data: "AAAA",
      error: null,
    },
    {
      url: "https://example.com/x.png",
      alt: "ext",
      source: "description",
      commentId: null,
      mimeType: null,
      data: null,
      error: "HTTP 403",
    },
    {
      url: "https://plane.example/api/v1/workspaces/acme/assets/log.png",
      alt: "log",
      source: "comment",
      commentId: "c3",
      mimeType: "image/png",
      data: "BBBB",
      error: null,
    },
  ],
};

describe("orderComments", () => {
  it("lists flat comments oldest first", () => {
    expect(orderComments(detail.comments).map((comment) => comment.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("hydratePrompt", () => {
  const prompt = hydratePrompt(DEFAULT_PROMPT_TEMPLATE, detail);

  it("fills every placeholder", () => {
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(prompt).toContain("Work on Plane work item ENG-42: Broken avatar upload");
    expect(prompt).toContain(detail.url);
    expect(prompt).toContain("Project: Engineering (ENG)");
    expect(prompt).toContain("Assignees: sam, Kim");
    expect(prompt).toContain("Cycle: Sprint 12");
    expect(prompt).toContain("Branch: eng-42-broken-avatar-upload");
  });

  it("numbers attached images and keeps failed ones as URLs", () => {
    expect(prompt).toContain("[attached image: screenshot #1]");
    expect(prompt).toContain("[image: ext: https://example.com/x.png]");
    expect(prompt).toContain("[attached image: log #2]");
    expect(prompt).toContain("2 images from the work item are attached");
    expect(prompt).toContain("1 image could not be downloaded");
  });

  it("renders comments in order with authors and dates", () => {
    expect(prompt).toContain(
      "- **sam** (2026-09-02): First comment\n  with two lines\n- **Kim** (2026-09-03): Reply to first",
    );
    expect(prompt).toContain("- **unknown** (2026-09-04): Later [attached image: log #2]");
  });

  it("lists attachments as links", () => {
    expect(prompt).toContain("## Links\n- PR #12: https://github.com/acme/app/pull/12");
  });

  it("leaves unknown placeholders alone and collapses blank runs", () => {
    const custom = hydratePrompt("{{identifier}}\n\n\n\n{{nope}}", detail);
    expect(custom).toBe("ENG-42\n\n{{nope}}");
  });

  it("falls back for empty description and comments", () => {
    const bare = hydratePrompt("{{description}}|{{comments}}|{{links}}|{{images}}", {
      ...detail,
      description: "  ",
      comments: [],
      attachments: [],
      images: [],
    });
    expect(bare).toBe("(no description)|(no comments)||");
  });
});

describe("text renderings", () => {
  it("ticketText contains the whole ticket without instructions", () => {
    const text = ticketText(detail);
    expect(text.startsWith("ENG-42: Broken avatar upload")).toBe(true);
    expect(text).toContain("## Comments");
    expect(text).not.toContain("Plan before you code");
  });

  it("issueSummaryText is compact and includes the branch", () => {
    const text = issueSummaryText(detail);
    expect(text).toContain("Plane work item ENG-42: Broken avatar upload");
    expect(text).toContain("Assignees: sam, Kim");
    expect(text).toContain("Branch: eng-42-broken-avatar-upload");
    expect(text).toContain("Uploads over 2 MB fail.");
  });
});

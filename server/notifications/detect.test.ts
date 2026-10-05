import { describe, expect, it } from "vitest";
import { detectNotifications, type PlaneActivity, type WorkItemRef } from "./detect";

const ME = "me";
const SINCE = "2026-10-04T10:00:00Z";
const LATER = "2026-10-04T11:00:00Z";
const EARLIER = "2026-10-04T09:00:00Z";
const nameOf = (id: string | null | undefined) => (id === "sam" ? "sam.lee" : "Someone");

function item(overrides: Partial<WorkItemRef> = {}): WorkItemRef {
  return {
    id: "i1",
    key: "PASEO-14",
    name: "Split counts",
    url: "https://plane.example/aight/projects/p/issues/i1/",
    assignees: [],
    createdBy: "sam",
    ...overrides,
  };
}

function activity(overrides: Partial<PlaneActivity>): PlaneActivity {
  return {
    id: "a1",
    verb: "updated",
    field: null,
    old_value: null,
    new_value: null,
    new_identifier: null,
    actor: "sam",
    created_at: LATER,
    ...overrides,
  };
}

describe("detectNotifications", () => {
  it("reports being assigned by someone else", () => {
    const found = detectNotifications({
      me: ME,
      since: SINCE,
      nameOf,
      item: item(),
      comments: [],
      activities: [
        activity({ field: "assignees", new_value: "gordon.lee", new_identifier: ME }),
        activity({ id: "a2", field: "assignees", new_identifier: "someone-else" }),
      ],
    });
    expect(found).toEqual([
      {
        id: "act:a1",
        title: "PASEO-14 Split counts",
        detail: "sam.lee assigned it to you",
        url: "https://plane.example/aight/projects/p/issues/i1/",
        createdAt: LATER,
      },
    ]);
  });

  it("reports state changes only on the viewer's items, never the viewer's own actions", () => {
    const stateChange = activity({ field: "state", old_value: "Todo", new_value: "Done" });
    expect(
      detectNotifications({
        me: ME,
        since: SINCE,
        nameOf,
        item: item(),
        comments: [],
        activities: [stateChange],
      }),
    ).toEqual([]);
    const mine = detectNotifications({
      me: ME,
      since: SINCE,
      nameOf,
      item: item({ assignees: [ME] }),
      comments: [],
      activities: [stateChange, activity({ id: "a3", field: "state", actor: ME })],
    });
    expect(mine.map((n) => n.detail)).toEqual(["sam.lee moved it: Todo → Done"]);
  });

  it("ignores activity at or before the cursor", () => {
    const found = detectNotifications({
      me: ME,
      since: SINCE,
      nameOf,
      item: item({ assignees: [ME] }),
      comments: [],
      activities: [activity({ field: "state", created_at: EARLIER })],
    });
    expect(found).toEqual([]);
  });

  it("reports comments on the viewer's items and mentions anywhere", () => {
    const comments = [
      { id: "c1", comment_html: "<p>Looks good &amp; done</p>", actor: "sam", created_at: LATER },
      {
        id: "c2",
        comment_html: `<p>ping <mention-component entity_identifier="${ME}"></mention-component></p>`,
        created_by: "sam",
        created_at: LATER,
      },
      { id: "c3", comment_html: "<p>mine</p>", actor: ME, created_at: LATER },
    ];
    const notMine = detectNotifications({
      me: ME,
      since: SINCE,
      nameOf,
      item: item(),
      activities: [],
      comments,
    });
    expect(notMine.map((n) => [n.id, n.detail])).toEqual([
      ["cmt:c2", "sam.lee mentioned you: ping"],
    ]);
    const mine = detectNotifications({
      me: ME,
      since: SINCE,
      nameOf,
      item: item({ createdBy: ME }),
      activities: [],
      comments,
    });
    expect(mine.map((n) => n.detail)).toEqual([
      "sam.lee commented: Looks good & done",
      "sam.lee mentioned you: ping",
    ]);
  });
});

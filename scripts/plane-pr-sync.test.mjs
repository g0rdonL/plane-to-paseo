import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commentBody,
  externalId,
  GitHub,
  MARKER,
  ownItem,
  Plane,
  stateFor,
  summaryOf,
  ticketRef,
} from "./plane-pr-sync.mjs";

const pr = (over = {}) => ({
  number: 4,
  title: "Add my sprint filter",
  url: "https://github.com/g0rdonL/plane-to-paseo/pull/4",
  body: "## Summary\n\nAdds a **My sprint** filter backed by [the fork](https://x.y).\n\n🤖 Generated",
  author: "g0rdonL",
  headRef: "feature/x",
  baseRef: "main",
  draft: false,
  state: "open",
  createdAt: "2026-10-04T20:00:00Z",
  mergedAt: null,
  closedAt: null,
  ...over,
});

describe("ticketRef", () => {
  it("reads the hand-off branch name", () => {
    assert.equal(ticketRef(pr({ headRef: "paseo-7-my-sprint-filter" }), "PASEO"), 7);
    assert.equal(ticketRef(pr({ headRef: "gordon/PASEO-12" }), "PASEO"), 12);
  });
  it("falls back to the title", () => {
    assert.equal(ticketRef(pr({ title: "PASEO-3: verify edits" }), "PASEO"), 3);
    assert.equal(ticketRef(pr({ title: "Fix (paseo-8)" }), "PASEO"), 8);
  });
  it("ignores other projects and lookalikes", () => {
    assert.equal(ticketRef(pr({ headRef: "eng-7-x", title: "ENG-7" }), "PASEO"), null);
    assert.equal(ticketRef(pr({ headRef: "paseo-7x" }), "PASEO"), null);
  });
});

describe("stateFor", () => {
  it("maps PR lifecycle to states", () => {
    assert.equal(stateFor(pr({ draft: true }), { linked: true }), "In Progress");
    assert.equal(stateFor(pr(), { linked: true }), "In Review");
    assert.equal(
      stateFor(pr({ state: "closed", mergedAt: "2026-10-05T00:00:00Z" }), { linked: true }),
      "Done",
    );
  });
  it("leaves a linked ticket alone when the PR closes unmerged", () => {
    assert.equal(stateFor(pr({ state: "closed" }), { linked: true }), null);
    assert.equal(stateFor(pr({ state: "closed" }), { linked: false }), "Cancelled");
  });
});

describe("ownItem", () => {
  it("keys by repo and number and summarises the body", () => {
    const item = ownItem(pr(), "g0rdonL/plane-to-paseo");
    assert.equal(item.external_id, "plane-to-paseo#4");
    assert.equal(item.name, "Add my sprint filter (plane-to-paseo#4)");
    assert.equal(item.start_date, "2026-10-05"); // HK date
    assert.match(item.description_html, /Adds a My sprint filter backed by the fork\./);
    assert.equal(externalId("o/agentdash-paseo", 1), "agentdash-paseo#1");
  });
  it("escapes HTML", () => {
    assert.match(ownItem(pr({ title: "<b>x</b>" }), "o/r").description_html, /o\/r #4/);
    assert.equal(summaryOf("<script>"), "<script>");
    assert.doesNotMatch(
      ownItem(pr({ body: "<script>alert(1)</script>" }), "o/r").description_html,
      /<script>/,
    );
  });
});

describe("commentBody", () => {
  it("starts with the marker and links the ticket", () => {
    const body = commentBody({
      key: "PASEO-7",
      url: "https://p/aight/browse/PASEO-7/",
      linked: true,
    });
    assert.ok(body.startsWith(MARKER));
    assert.match(body, /\[PASEO-7\]\(https:\/\/p\/aight\/browse\/PASEO-7\/\)/);
  });
});

// ---------------------------------------------------------------------------
// Against fakes
// ---------------------------------------------------------------------------

function json(status, data) {
  return new Response(data === null ? "" : JSON.stringify(data), { status });
}

function planeFake() {
  const calls = [];
  const items = new Map([["paseo-7", { id: "wi-7", sequence_id: 7, labels: [] }]]);
  let next = 20;
  const links = new Map();
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/api/v1/workspaces/aight", "");
    const query = new URL(url).searchParams;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/projects/") return json(200, { results: [{ id: "p1", identifier: "PASEO" }] });
    if (path === "/projects/p1/states/")
      return json(200, {
        results: ["In Progress", "In Review", "Done", "Cancelled"].map((name) => ({
          id: `s-${name}`,
          name,
        })),
      });
    if (path === "/projects/p1/labels/" && method === "GET") return json(200, { results: [] });
    if (path === "/projects/p1/labels/" && method === "POST")
      return json(201, { id: "l-new", name: body.name });
    const key = /^\/work-items\/PASEO-(\d+)\/$/.exec(path);
    if (key) {
      const item = items.get(`paseo-${key[1]}`);
      return item ? json(200, item) : json(404, { error: "not found" });
    }
    if (path === "/projects/p1/work-items/" && method === "GET") {
      const hit = [...items.values()].find((i) => i.external_id === query.get("external_id"));
      return hit ? json(200, hit) : json(404, { error: "not found" });
    }
    if (path === "/projects/p1/work-items/" && method === "POST") {
      const item = { id: `wi-${next}`, sequence_id: next, ...body };
      items.set(`paseo-${next++}`, item);
      return json(201, item);
    }
    const linkPath = /^\/projects\/p1\/work-items\/([\w-]+)\/links\/$/.exec(path);
    if (linkPath) {
      const list = links.get(linkPath[1]) ?? [];
      if (method === "POST") list.push(body);
      links.set(linkPath[1], list);
      return method === "POST" ? json(201, body) : json(200, { results: list });
    }
    if (/^\/projects\/p1\/work-items\/[\w-]+\/$/.test(path) && method === "PATCH")
      return json(200, {});
    return json(500, { error: `unhandled ${method} ${path}` });
  };
  return { fetcher, calls, links };
}

function githubFake() {
  const comments = [];
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/repos/o/plane-to-paseo", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, auth: init.headers?.Authorization });
    if (/^\/issues\/\d+\/comments$/.test(path) && method === "GET") return json(200, comments);
    if (/^\/issues\/\d+\/comments$/.test(path) && method === "POST") {
      comments.push({ id: comments.length + 1, body: body.body });
      return json(201, {});
    }
    const edit = /^\/issues\/comments\/(\d+)$/.exec(path);
    if (edit) {
      comments[Number(edit[1]) - 1].body = body.body;
      return json(200, {});
    }
    return json(500, {});
  };
  return { fetcher, comments, calls };
}

async function run(prObj, planeF, githubF) {
  const plane = new Plane(
    {
      baseUrl: "https://plane.example/",
      apiKey: "k",
      workspace: "aight",
      project: "PASEO",
      label: "plane-to-paseo",
    },
    planeF.fetcher,
  );
  await plane.init();
  const ref = ticketRef(prObj, "PASEO");
  const linked = ref === null ? null : await plane.syncLinked(prObj, ref);
  const result = linked ?? (await plane.syncOwn(prObj, "o/plane-to-paseo"));
  const github = new GitHub({ repo: "o/plane-to-paseo", token: "t" }, githubF.fetcher);
  await github.upsertComment(
    prObj.number,
    commentBody({ key: result.key, url: result.url, linked: Boolean(linked) }),
  );
  return result;
}

describe("sync against fakes", () => {
  it("moves the referenced ticket, links the PR once, and edits one comment in place", async () => {
    const planeF = planeFake();
    const githubF = githubFake();
    const draft = pr({ headRef: "paseo-7-my-sprint-filter", draft: true });
    assert.deepEqual(await run(draft, planeF, githubF), {
      key: "PASEO-7",
      url: "https://plane.example/aight/browse/PASEO-7/",
      state: "In Progress",
      created: false,
    });
    await run({ ...draft, draft: false }, planeF, githubF);
    const patches = planeF.calls.filter((c) => c.method === "PATCH").map((c) => c.body.state);
    assert.deepEqual(patches, ["s-In Progress", "s-In Review"]);
    assert.equal(planeF.links.get("wi-7").length, 1);
    assert.equal(githubF.comments.length, 1);
    assert.match(githubF.comments[0].body, /PASEO-7/);
    assert.ok(githubF.calls.every((c) => c.auth === "Bearer t"));
  });

  it("creates an own item for an untracked PR, creating the label, then updates it", async () => {
    const planeF = planeFake();
    const githubF = githubFake();
    const first = await run(pr(), planeF, githubF);
    assert.equal(first.created, true);
    const post = planeF.calls.find(
      (c) => c.method === "POST" && c.path === "/projects/p1/work-items/",
    );
    assert.deepEqual(post.body.labels, ["l-new"]);
    assert.equal(post.body.state, "s-In Review");
    const second = await run(pr({ state: "closed" }), planeF, githubF);
    assert.equal(second.created, false);
    assert.equal(second.key, first.key);
    assert.equal(planeF.calls.filter((c) => c.method === "PATCH").at(-1).body.state, "s-Cancelled");
  });

  it("falls back to an own item when the referenced ticket does not exist", async () => {
    const result = await run(pr({ headRef: "paseo-99-gone" }), planeFake(), githubFake());
    assert.equal(result.created, true);
  });
});

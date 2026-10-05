import { describe, expect, it } from "vitest";
import { collectPages, createPlaneClient, normalizeInstanceUrl, PlaneError } from "./client";
import { json, withHttpServer } from "./test-server";

const TOKEN = "plane_api_test_token";

describe("createPlaneClient", () => {
  it("sends the API key header and query params to /api/v1", async () => {
    await withHttpServer(
      (_request, response) => json(response, 200, { ok: true }),
      async (origin, requests) => {
        const client = createPlaneClient({ token: ` ${TOKEN} `, instanceUrl: `${origin}/` });
        expect(client.instanceUrl).toBe(origin);
        await client.get("workspaces/w/projects/", { per_page: 10, cursor: null, empty: "" });
        expect(requests[0]?.url).toBe("/api/v1/workspaces/w/projects/?per_page=10");
        expect(requests[0]?.apiKey).toBe(TOKEN);
        expect(requests[0]?.method).toBe("GET");
      },
    );
  });

  it("sends JSON bodies on POST and PATCH", async () => {
    await withHttpServer(
      (_request, response) => json(response, 200, {}),
      async (origin, requests) => {
        const client = createPlaneClient({ token: TOKEN, instanceUrl: origin });
        await client.post("a/", { comment_html: "<p>x</p>" });
        await client.patch("b/", { state: "s1" });
        expect(requests.map((r) => [r.method, r.body])).toEqual([
          ["POST", { comment_html: "<p>x</p>" }],
          ["PATCH", { state: "s1" }],
        ]);
      },
    );
  });

  it.each([
    [401, "auth", /rejected the API token/],
    [403, "forbidden", /lacks permission/],
    [404, "not_found", /Not found in Plane/],
    [500, "http", /unavailable \(HTTP 500\)/],
    [400, "http", /HTTP 400\): name: required/],
  ])("maps HTTP %s to a %s error", async (status, kind, message) => {
    await withHttpServer(
      (_request, response) =>
        json(response, status, status === 400 ? { name: ["required"] } : { detail: "nope" }),
      async (origin) => {
        const client = createPlaneClient({ token: TOKEN, instanceUrl: origin, maxRetries: 0 });
        const error = await client.get("x/").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PlaneError);
        expect((error as PlaneError).kind).toBe(kind);
        expect((error as PlaneError).message).toMatch(message);
        expect((error as PlaneError).message).not.toContain(TOKEN);
      },
    );
  });

  it("retries 429 responses with back-off, then gives up", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withHttpServer(
      (_request, response) => {
        calls++;
        if (calls === 1) {
          response.writeHead(429, { "Retry-After": "2", "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        json(response, 200, { ok: calls });
      },
      async (origin) => {
        const client = createPlaneClient({
          token: TOKEN,
          instanceUrl: origin,
          sleep: async (ms) => {
            delays.push(ms);
          },
        });
        await expect(client.get("x/")).resolves.toEqual({ ok: 2 });
        expect(delays).toEqual([2000]);
      },
    );
    await withHttpServer(
      (_request, response) => json(response, 429, {}),
      async (origin) => {
        const client = createPlaneClient({
          token: TOKEN,
          instanceUrl: origin,
          maxRetries: 1,
          sleep: async () => {},
        });
        await expect(client.get("x/")).rejects.toMatchObject({ kind: "rate_limit" });
      },
    );
  });

  it("rejects non-JSON responses with a hint about the instance URL", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><html></html>");
      },
      async (origin) => {
        const client = createPlaneClient({ token: TOKEN, instanceUrl: origin });
        await expect(client.get("x/")).rejects.toThrow(/check the instance URL/);
      },
    );
  });

  it("reports network failures without the token", async () => {
    const client = createPlaneClient({
      token: TOKEN,
      instanceUrl: "http://127.0.0.1:1",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const error = (await client.get("x/").catch((e: unknown) => e)) as PlaneError;
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/Could not reach Plane at http:\/\/127\.0\.0\.1:1/);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("collectPages", () => {
  function pagedServer(total: number) {
    return (request: { url: string }, response: Parameters<typeof json>[0]) => {
      const url = new URL(request.url, "http://x");
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number((url.searchParams.get("cursor") ?? `${perPage}:0:0`).split(":")[1]);
      const start = page * perPage;
      const results = Array.from(
        { length: Math.max(0, Math.min(perPage, total - start)) },
        (_, i) => ({ n: start + i }),
      );
      const more = start + perPage < total;
      json(response, 200, {
        results,
        next_cursor: `${perPage}:${page + 1}:0`,
        next_page_results: more,
        total_count: total,
      });
    };
  }

  it("follows cursors until exhausted", async () => {
    await withHttpServer(pagedServer(5), async (origin, requests) => {
      const client = createPlaneClient({ token: TOKEN, instanceUrl: origin });
      const result = await collectPages<{ n: number }>(
        client,
        "items/",
        {},
        {
          perPage: 2,
          maxItems: 100,
        },
      );
      expect(result.items.map((item) => item.n)).toEqual([0, 1, 2, 3, 4]);
      expect(result.truncated).toBe(false);
      expect(requests).toHaveLength(3);
    });
  });

  it("stops at maxItems and reports truncation", async () => {
    await withHttpServer(pagedServer(10), async (origin) => {
      const client = createPlaneClient({ token: TOKEN, instanceUrl: origin });
      const result = await collectPages(client, "items/", {}, { perPage: 3, maxItems: 4 });
      expect(result.items).toHaveLength(4);
      expect(result.truncated).toBe(true);
    });
  });

  it("treats a bare array as a single complete page", async () => {
    await withHttpServer(
      (_request, response) => json(response, 200, [{ n: 1 }, { n: 2 }]),
      async (origin, requests) => {
        const client = createPlaneClient({ token: TOKEN, instanceUrl: origin });
        const result = await collectPages(client, "members/", {}, { perPage: 100, maxItems: 10 });
        expect(result).toEqual({ items: [{ n: 1 }, { n: 2 }], truncated: false });
        expect(requests).toHaveLength(1);
      },
    );
  });
});

describe("normalizeInstanceUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeInstanceUrl(" https://plane.aight.to/// ")).toBe("https://plane.aight.to");
  });
});

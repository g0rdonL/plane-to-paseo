export type PlaneErrorKind = "auth" | "forbidden" | "not_found" | "rate_limit" | "http" | "network";

export class PlaneError extends Error {
  constructor(
    message: string,
    readonly kind: PlaneErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "PlaneError";
  }
}

export interface PlaneClientOptions {
  token: string;
  /** Instance origin, e.g. https://plane.aight.to */
  instanceUrl: string;
  fetchImpl?: typeof fetch;
  /** Test seam for 429 back-off. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface PlaneClient {
  readonly instanceUrl: string;
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
}

/** Plane's cursor-paginated envelope. Some list endpoints return a bare array instead. */
export interface PlanePage<T> {
  results: T[];
  next_cursor?: string | null;
  next_page_results?: boolean;
  total_count?: number;
}

export function normalizeInstanceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function describeStatus(
  status: number,
  detail: string | null,
): { message: string; kind: PlaneErrorKind } {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401) return { message: `Plane rejected the API token${suffix}`, kind: "auth" };
  if (status === 403)
    return {
      message: `The Plane API token lacks permission for this request${suffix}`,
      kind: "forbidden",
    };
  if (status === 404) return { message: `Not found in Plane${suffix}`, kind: "not_found" };
  if (status === 429)
    return { message: "Plane rate limit reached, try again in a minute", kind: "rate_limit" };
  if (status >= 500) return { message: `Plane is unavailable (HTTP ${status})`, kind: "http" };
  return { message: `Plane API request failed (HTTP ${status})${suffix}`, kind: "http" };
}

/** Plane answers with `{ detail }`, `{ error }`, or a field→messages map. */
function errorDetail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["detail", "error", "message"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  const parts = Object.entries(record)
    .filter(([, value]) => Array.isArray(value) || typeof value === "string")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
  return parts.length ? parts.join("; ").slice(0, 300) : null;
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 30) * 1000;
  return 1000 * 2 ** attempt;
}

export function createPlaneClient(options: PlaneClientOptions): PlaneClient {
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  const apiBase = `${instanceUrl}/api/v1/`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 2;
  const token = options.token.trim();

  async function request<T>(
    method: string,
    path: string,
    query?: Query,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ""), apiBase);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "")
        url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Accept: "application/json",
            "X-Api-Key": token,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        // `cause` can carry request details; surface only the message.
        throw new PlaneError(
          `Could not reach Plane at ${instanceUrl}: ${(error as Error).message}`,
          "network",
        );
      }
      if (response.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (!response.ok) {
        const { message, kind } = describeStatus(response.status, errorDetail(parsed));
        throw new PlaneError(message, kind, response.status);
      }
      if (text && parsed === null) {
        // Usually an HTML page from a proxy or SPA fallback: wrong instance URL.
        throw new PlaneError(
          `Plane returned a non-JSON response from ${url.pathname}; check the instance URL`,
          "http",
          response.status,
        );
      }
      return parsed as T;
    }
  }

  return {
    instanceUrl,
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, undefined, body),
    patch: (path, body) => request("PATCH", path, undefined, body),
  };
}

/**
 * Walks Plane cursor pages until exhausted or `maxItems` is collected. Bare-array responses are
 * treated as a single complete page.
 */
export async function collectPages<T>(
  client: PlaneClient,
  path: string,
  query: Query,
  limits: { perPage: number; maxItems: number; maxPages?: number },
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;
  const maxPages = limits.maxPages ?? Math.ceil(limits.maxItems / limits.perPage) + 1;
  for (let page = 0; page < maxPages; page++) {
    const response: PlanePage<T> | T[] = await client.get<PlanePage<T> | T[]>(path, {
      ...query,
      per_page: limits.perPage,
      cursor,
    });
    if (Array.isArray(response)) {
      items.push(...response);
      return { items: items.slice(0, limits.maxItems), truncated: items.length > limits.maxItems };
    }
    items.push(...(response.results ?? []));
    const more = Boolean(response.next_page_results && response.next_cursor);
    if (items.length >= limits.maxItems) {
      return {
        items: items.slice(0, limits.maxItems),
        truncated: more || items.length > limits.maxItems,
      };
    }
    if (!more) return { items, truncated: false };
    cursor = response.next_cursor ?? null;
  }
  return { items, truncated: true };
}

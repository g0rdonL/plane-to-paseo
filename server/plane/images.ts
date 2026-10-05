import type { IssueImage } from "../../shared/contracts";

export interface ImageSource {
  url: string;
  alt: string | null;
  source: "description" | "comment" | "attachment";
  commentId: string | null;
}

export interface DownloadImagesOptions {
  fetchImpl?: typeof fetch;
  /** Images beyond this count are reported with an error instead of downloaded. */
  maxCount?: number;
  /** Per-image byte cap; larger files are skipped. */
  maxBytes?: number;
  /** Wall-clock budget for the whole batch. */
  budgetMs?: number;
  concurrency?: number;
  /**
   * Turns a reference URL into the URL to download. Plane assets resolve through the API to a
   * short-lived presigned URL; the default downloads the URL as-is.
   */
  resolveUrl?: (url: string, signal: AbortSignal) => Promise<string>;
}

export const IMAGE_DEFAULTS = {
  maxCount: 10,
  maxBytes: 8 * 1024 * 1024,
  budgetMs: 20_000,
  concurrency: 3,
} as const;

function guessMimeType(url: string, header: string | null): string | null {
  const fromHeader = header?.split(";")[0]?.trim().toLowerCase();
  if (fromHeader?.startsWith("image/")) return fromHeader;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  const table: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    heic: "image/heic",
  };
  return extension && table[extension] ? table[extension] : null;
}

async function downloadOne(
  source: ImageSource,
  options: Required<Omit<DownloadImagesOptions, "fetchImpl">> & { fetchImpl: typeof fetch },
  signal: AbortSignal,
): Promise<IssueImage> {
  const base: IssueImage = {
    url: source.url,
    alt: source.alt,
    source: source.source,
    commentId: source.commentId,
    mimeType: null,
    data: null,
    error: null,
  };
  try {
    const target = await options.resolveUrl(source.url, signal);
    // React Native's global fetch typings shadow Node's; the runtime here is always Node.
    // No credentials here: presigned URLs carry their own signature.
    const response = await options.fetchImpl(target, {
      signal: signal as unknown as NonNullable<RequestInit["signal"]>,
    });
    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status}` };
    }
    const mimeType = guessMimeType(target, response.headers.get("content-type"));
    if (!mimeType) {
      return { ...base, error: "not an image" };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > options.maxBytes) {
      return {
        ...base,
        mimeType,
        error: `larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB`,
      };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > options.maxBytes) {
      return {
        ...base,
        mimeType,
        error: `larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB`,
      };
    }
    return { ...base, mimeType, data: bytes.toString("base64") };
  } catch (error) {
    const message = signal.aborted ? "download budget exceeded" : (error as Error).message;
    return { ...base, error: message };
  }
}

/** Downloads images in order with bounded concurrency; failures are per-image, never fatal. */
export async function downloadImages(
  sources: readonly ImageSource[],
  options: DownloadImagesOptions,
): Promise<IssueImage[]> {
  const resolved = {
    fetchImpl: options.fetchImpl ?? fetch,
    maxCount: options.maxCount ?? IMAGE_DEFAULTS.maxCount,
    maxBytes: options.maxBytes ?? IMAGE_DEFAULTS.maxBytes,
    budgetMs: options.budgetMs ?? IMAGE_DEFAULTS.budgetMs,
    concurrency: options.concurrency ?? IMAGE_DEFAULTS.concurrency,
    resolveUrl: options.resolveUrl ?? (async (url: string) => url),
  };
  const results: IssueImage[] = new Array(sources.length);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.budgetMs);

  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const index = next++;
      const source = sources[index] as ImageSource;
      if (index >= resolved.maxCount) {
        results[index] = {
          url: source.url,
          alt: source.alt,
          source: source.source,
          commentId: source.commentId,
          mimeType: null,
          data: null,
          error: `skipped, more than ${resolved.maxCount} images`,
        };
        continue;
      }
      results[index] = await downloadOne(source, resolved, controller.signal);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(resolved.concurrency, sources.length)) }, worker),
    );
  } finally {
    clearTimeout(timer);
  }
  return results;
}

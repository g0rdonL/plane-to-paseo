/**
 * Plane stores descriptions and comments as TipTap HTML. These helpers turn that HTML into the
 * Markdown the app renders and the agent prompt carries. Pure functions with no DOM: the daemon
 * converts once, and both runtimes share the image helpers.
 */

export interface MarkdownImageRef {
  url: string;
  alt: string | null;
}

export interface HtmlToMarkdownOptions {
  /**
   * Maps an `<image-component src>` value to a fetchable URL. Plane stores the asset id there; the
   * daemon rewrites it to the instance's asset endpoint. Absolute URLs are passed in unchanged.
   */
  resolveAsset?: (src: string) => string | null;
  /** Maps a mentioned user id to a display name. */
  resolveMention?: (id: string) => string | null;
}

// ---------------------------------------------------------------------------
// Tokenising and tree building
// ---------------------------------------------------------------------------

interface ElementNode {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
interface TextNode {
  type: "text";
  text: string;
}
type HtmlNode = ElementNode | TextNode;

const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "col",
  "source",
  "wbr",
  "image-component",
]);
const DROPPED_TAGS = new Set(["script", "style", "noscript", "template", "iframe", "object"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "table",
  "hr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function parseHtml(html: string): HtmlNode[] {
  const root: ElementNode = { type: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0;
  let dropping: string | null = null;
  const current = () => stack[stack.length - 1] as ElementNode;

  for (const match of html.matchAll(pattern)) {
    const index = match.index;
    if (index > last && !dropping) {
      current().children.push({ type: "text", text: decodeEntities(html.slice(last, index)) });
    }
    last = index + match[0].length;
    if (match[0].startsWith("<!--")) continue;

    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const rawAttrs = match[3] ?? "";

    if (dropping) {
      if (closing && tag === dropping) dropping = null;
      continue;
    }
    if (DROPPED_TAGS.has(tag)) {
      if (!closing && !rawAttrs.trimEnd().endsWith("/")) dropping = tag;
      continue;
    }
    if (closing) {
      // Pop to the matching open tag; ignore stray closers.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]?.tag === tag) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const node: ElementNode = { type: "element", tag, attrs: parseAttrs(rawAttrs), children: [] };
    current().children.push(node);
    if (!VOID_TAGS.has(tag) && !rawAttrs.trimEnd().endsWith("/")) stack.push(node);
  }
  if (last < html.length && !dropping) {
    current().children.push({ type: "text", text: decodeEntities(html.slice(last)) });
  }
  return root.children;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface RenderContext {
  options: HtmlToMarkdownOptions;
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, " ");
}

function textContent(nodes: HtmlNode[]): string {
  return nodes
    .map((node) => (node.type === "text" ? node.text : textContent(node.children)))
    .join("");
}

function wrapInline(marker: string, inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  const lead = inner.match(/^\s*/)?.[0] ?? "";
  const trail = inner.match(/\s*$/)?.[0] ?? "";
  return `${lead}${marker}${trimmed}${marker}${trail}`;
}

function renderInline(nodes: HtmlNode[], ctx: RenderContext): string {
  return nodes.map((node) => renderNode(node, ctx)).join("");
}

function renderImage(src: string, alt: string | null, ctx: RenderContext): string {
  if (!src) return "";
  const url = isAbsoluteUrl(src) ? src : (ctx.options.resolveAsset?.(src) ?? null);
  if (!url) return alt ? `[image: ${alt}]` : "[image]";
  return `![${alt ?? ""}](${url})`;
}

function renderList(node: ElementNode, ctx: RenderContext): string {
  const ordered = node.tag === "ol";
  const start = Number.parseInt(node.attrs.start ?? "1", 10) || 1;
  const items = node.children.filter(
    (child): child is ElementNode => child.type === "element" && child.tag === "li",
  );
  const lines = items.map((item, i) => {
    let marker = ordered ? `${start + i}.` : "-";
    if (item.attrs["data-checked"] !== undefined) {
      marker = `- [${item.attrs["data-checked"] === "true" ? "x" : " "}]`;
    }
    // Tight list: paragraphs inside an item are separated by single line breaks.
    const body = renderBlocks(item.children, ctx)
      .trim()
      .replace(/\n{2,}/g, "\n");
    const indent = " ".repeat(marker.length + 1);
    const [first = "", ...rest] = body.split("\n");
    return [`${marker} ${first}`, ...rest.map((line) => (line ? indent + line : line))].join("\n");
  });
  return `\n\n${lines.join("\n")}\n\n`;
}

function renderTable(node: ElementNode, ctx: RenderContext): string {
  const rows: string[][] = [];
  const collect = (nodes: HtmlNode[]) => {
    for (const child of nodes) {
      if (child.type !== "element") continue;
      if (child.tag === "tr") {
        rows.push(
          child.children
            .filter(
              (cell): cell is ElementNode =>
                cell.type === "element" && (cell.tag === "td" || cell.tag === "th"),
            )
            .map((cell) =>
              renderBlocks(cell.children, ctx).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|"),
            ),
        );
      } else {
        collect(child.children);
      }
    }
  };
  collect(node.children);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];
  const [header = [], ...body] = rows;
  const lines = [
    `| ${pad(header).join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

function renderNode(node: HtmlNode, ctx: RenderContext): string {
  if (node.type === "text") return collapseWhitespace(node.text);
  const { tag, attrs, children } = node;
  switch (tag) {
    case "p":
    case "div":
      return `\n\n${renderInline(children, ctx).trim()}\n\n`;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${renderInline(children, ctx).trim()}\n\n`;
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b":
      return wrapInline("**", renderInline(children, ctx));
    case "em":
    case "i":
      return wrapInline("_", renderInline(children, ctx));
    case "s":
    case "del":
    case "strike":
      return wrapInline("~~", renderInline(children, ctx));
    case "code":
      return wrapInline("`", textContent(children));
    case "pre": {
      const code = children.find(
        (child): child is ElementNode => child.type === "element" && child.tag === "code",
      );
      const language = (code?.attrs.class ?? "").match(/language-([\w+-]+)/)?.[1] ?? "";
      const body = textContent(children).replace(/\n+$/, "");
      return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
    }
    case "blockquote": {
      const inner = renderBlocks(children, ctx).trim();
      return `\n\n${inner
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n")}\n\n`;
    }
    case "ul":
    case "ol":
      return renderList(node, ctx);
    case "table":
      return renderTable(node, ctx);
    case "a": {
      const text = renderInline(children, ctx).trim();
      const href = attrs.href ?? "";
      if (!href || !isAbsoluteUrl(href)) return text;
      return text && text !== href ? `[${text}](${href})` : `<${href}>`;
    }
    case "img":
      return renderImage(attrs.src ?? "", attrs.alt?.trim() || null, ctx);
    case "image-component":
      // A block node in Plane's editor.
      return `\n\n${renderImage(attrs.src ?? "", attrs.alt?.trim() || null, ctx)}\n\n`;
    case "mention-component": {
      const id = attrs.entity_identifier ?? attrs.id ?? "";
      const name = (id && ctx.options.resolveMention?.(id)) || attrs.label || "someone";
      return `@${name}`;
    }
    case "label":
    case "input":
      // TipTap task items render a checkbox inside a <label>; the list marker carries the state.
      return "";
    default:
      return BLOCK_TAGS.has(tag)
        ? `\n\n${renderBlocks(children, ctx)}\n\n`
        : renderInline(children, ctx);
  }
}

function renderBlocks(nodes: HtmlNode[], ctx: RenderContext): string {
  return renderInline(nodes, ctx)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Converts Plane's stored HTML into Markdown. Scripts, styles, and unknown attributes are dropped. */
export function htmlToMarkdown(
  html: string | null | undefined,
  options: HtmlToMarkdownOptions = {},
): string {
  if (!html?.trim()) return "";
  return renderBlocks(parseHtml(html), { options })
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lists the asset ids referenced by `<image-component>` nodes, in document order. */
export function extractAssetIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const ids: string[] = [];
  for (const match of html.matchAll(/<image-component\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const src = match[1] ?? "";
    if (src && !isAbsoluteUrl(src) && !ids.includes(src)) ids.push(src);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Image references in the converted Markdown
// ---------------------------------------------------------------------------

// ![alt](url "optional title")
const IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE_PATTERN = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** Returns every image reference in document order, de-duplicated by URL. */
export function extractImageRefs(markdown: string | null | undefined): MarkdownImageRef[] {
  if (!markdown) return [];
  const found: Array<{ index: number; url: string; alt: string | null }> = [];
  for (const match of markdown.matchAll(IMAGE_PATTERN)) {
    found.push({ index: match.index, url: match[2] ?? "", alt: match[1] ?? null });
  }
  for (const match of markdown.matchAll(HTML_IMAGE_PATTERN)) {
    found.push({ index: match.index, url: match[1] ?? "", alt: null });
  }
  found.sort((a, b) => a.index - b.index);

  const refs: MarkdownImageRef[] = [];
  const seen = new Set<string>();
  for (const { url, alt } of found) {
    if (!isAbsoluteUrl(url) || seen.has(url)) continue;
    seen.add(url);
    refs.push({ url, alt: alt && alt.trim().length > 0 ? alt.trim() : null });
  }
  return refs;
}

/** Replaces every image reference with `replacement(ref)`; used to render placeholders. */
export function replaceImageRefs(
  markdown: string,
  replacement: (ref: MarkdownImageRef) => string,
): string {
  return markdown
    .replace(IMAGE_PATTERN, (_match, alt: string, url: string) =>
      isAbsoluteUrl(url) ? replacement({ url, alt: alt.trim() || null }) : _match,
    )
    .replace(HTML_IMAGE_PATTERN, (_match, url: string) =>
      isAbsoluteUrl(url) ? replacement({ url, alt: null }) : _match,
    );
}

/** The daemon-side asset endpoint for an `<image-component>` id. */
export function assetApiUrl(instanceUrl: string, workspaceSlug: string, assetId: string): string {
  return `${instanceUrl.replace(/\/+$/, "")}/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/assets/${encodeURIComponent(assetId)}/`;
}

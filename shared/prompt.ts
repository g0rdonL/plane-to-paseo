import type { Issue, IssueComment, IssueDetail } from "./contracts";
import { replaceImageRefs } from "./plane-markdown";

export const DEFAULT_PROMPT_TEMPLATE = `Work on Plane work item {{identifier}}: {{title}}
{{url}}

{{meta}}

## Description
{{description}}

## Comments
{{comments}}
{{links}}
{{images}}
Follow this repo's conventions (CLAUDE.md / AGENTS.md if present). Plan before you code, and
keep the work item's scope; ask before widening it.`;

export const PROMPT_PLACEHOLDERS = [
  "identifier",
  "title",
  "url",
  "meta",
  "description",
  "comments",
  "links",
  "images",
] as const;

function day(iso: string): string {
  return iso.slice(0, 10);
}

function authorName(comment: IssueComment): string {
  return comment.user?.displayName ?? comment.user?.name ?? "unknown";
}

/** Replaces inline image markdown with a numbered placeholder matching the attached images. */
export function describeImages(markdown: string, imageIndex: Map<string, number>): string {
  return replaceImageRefs(markdown, (ref) => {
    const index = imageIndex.get(ref.url);
    const label = ref.alt ? `image: ${ref.alt}` : "image";
    return index ? `[attached ${label} #${index}]` : `[${label}: ${ref.url}]`;
  });
}

/** Plane comments are flat; list them oldest first. */
export function orderComments(comments: readonly IssueComment[]): IssueComment[] {
  return [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function assigneeNames(issue: Pick<Issue, "assignees">): string {
  return issue.assignees.map((user) => user.displayName ?? user.name).join(", ");
}

export function imageIndexFor(detail: IssueDetail): Map<string, number> {
  const index = new Map<string, number>();
  let n = 0;
  for (const image of detail.images) {
    if (image.data) index.set(image.url, ++n);
  }
  return index;
}

export function formatComments(detail: IssueDetail): string {
  if (detail.comments.length === 0) return "(no comments)";
  const index = imageIndexFor(detail);
  return orderComments(detail.comments)
    .map((comment) => {
      const body = describeImages(comment.body.trim(), index)
        .split("\n")
        .map((line, i) => (i === 0 ? line : `  ${line}`))
        .join("\n");
      return `- **${authorName(comment)}** (${day(comment.createdAt)}): ${body}`;
    })
    .join("\n");
}

export function formatMeta(detail: IssueDetail): string {
  const parts = [
    `Project: ${detail.project.name} (${detail.project.key})`,
    `Status: ${detail.state.name}`,
    `Priority: ${detail.priorityLabel}`,
  ];
  if (detail.assignees.length) parts.push(`Assignees: ${assigneeNames(detail)}`);
  if (detail.cycle) parts.push(`Cycle: ${detail.cycle.name}`);
  if (detail.labels.length)
    parts.push(`Labels: ${detail.labels.map((label) => label.name).join(", ")}`);
  if (detail.estimate) parts.push(`Estimate: ${detail.estimate}`);
  if (detail.dueDate) parts.push(`Due: ${detail.dueDate}`);
  if (detail.parent) parts.push(`Parent: ${detail.parent.identifier} ${detail.parent.title}`);
  parts.push(`Branch: ${detail.branchName}`);
  return parts.join("\n");
}

export function formatLinks(detail: IssueDetail): string {
  if (detail.attachments.length === 0) return "";
  const lines = detail.attachments.map(
    (attachment) => `- ${attachment.title?.trim() || attachment.url}: ${attachment.url}`,
  );
  return `\n## Links\n${lines.join("\n")}\n`;
}

export function formatImagesNote(detail: IssueDetail): string {
  const attached = detail.images.filter((image) => image.data).length;
  const failed = detail.images.length - attached;
  if (attached === 0 && failed === 0) return "";
  const parts: string[] = [];
  if (attached > 0) {
    parts.push(
      `${attached} image${attached === 1 ? "" : "s"} from the work item ${attached === 1 ? "is" : "are"} attached to this message, numbered in order of appearance.`,
    );
  }
  if (failed > 0) {
    parts.push(
      `${failed} image${failed === 1 ? "" : "s"} could not be downloaded; the URL is kept inline.`,
    );
  }
  return `\n${parts.join(" ")}\n`;
}

export function formatDescription(detail: IssueDetail): string {
  const description = detail.description?.trim();
  if (!description) return "(no description)";
  return describeImages(description, imageIndexFor(detail));
}

export function hydratePrompt(template: string, detail: IssueDetail): string {
  const values: Record<(typeof PROMPT_PLACEHOLDERS)[number], string> = {
    identifier: detail.identifier,
    title: detail.title,
    url: detail.url,
    meta: formatMeta(detail),
    description: formatDescription(detail),
    comments: formatComments(detail),
    links: formatLinks(detail),
    images: formatImagesNote(detail),
  };
  return template
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
      key in values ? values[key as keyof typeof values] : match,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Compact text for a list-level issue (no comments); used by the composer attachment source. */
export function issueSummaryText(issue: Issue): string {
  const lines = [
    `Plane work item ${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    `Project: ${issue.project.name} (${issue.project.key})`,
    `Status: ${issue.state.name}`,
    `Priority: ${issue.priorityLabel}`,
  ];
  if (issue.assignees.length) lines.push(`Assignees: ${assigneeNames(issue)}`);
  if (issue.labels.length)
    lines.push(`Labels: ${issue.labels.map((label) => label.name).join(", ")}`);
  lines.push(
    `Branch: ${issue.branchName}`,
    "",
    issue.descriptionPreview?.trim() || "No description.",
  );
  return lines.join("\n");
}

/** Plain-text rendering of the whole ticket, used for the composer attachment pill. */
export function ticketText(detail: IssueDetail): string {
  return hydratePrompt(
    `{{identifier}}: {{title}}\n{{url}}\n\n{{meta}}\n\n## Description\n{{description}}\n\n## Comments\n{{comments}}\n{{links}}`,
    detail,
  );
}

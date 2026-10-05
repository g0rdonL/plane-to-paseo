/**
 * Pure rules for which Plane events become launcher notifications. Plane's v1 API has no
 * notifications endpoint for API keys, so the poller reads each changed work item's activity
 * log (assignments, state changes) and comments (comments don't appear in activities).
 */

export interface PlaneActivity {
  id: string;
  verb: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  new_identifier?: string | null;
  actor: string | null;
  created_at: string;
}

export interface PlaneComment {
  id: string;
  comment_html: string | null;
  actor?: string | null;
  created_by?: string | null;
  created_at: string;
}

export interface WorkItemRef {
  id: string;
  key: string;
  name: string;
  url: string;
  assignees: string[];
  createdBy: string | null;
}

export interface DetectedNotification {
  id: string;
  title: string;
  detail: string;
  url: string;
  createdAt: string;
}

export interface DetectInput {
  me: string;
  item: WorkItemRef;
  since: string;
  activities: PlaneActivity[];
  comments: PlaneComment[];
  nameOf: (userId: string | null | undefined) => string;
}

function isMine(item: WorkItemRef, me: string): boolean {
  return item.assignees.includes(me) || item.createdBy === me;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectNotifications({
  me,
  item,
  since,
  activities,
  comments,
  nameOf,
}: DetectInput): DetectedNotification[] {
  const found: DetectedNotification[] = [];
  const mine = isMine(item, me);
  const title = `${item.key} ${item.name}`;

  for (const activity of activities) {
    if (activity.created_at <= since || !activity.actor || activity.actor === me) continue;
    const who = nameOf(activity.actor);
    if (activity.field === "assignees" && activity.new_identifier === me) {
      found.push({
        id: `act:${activity.id}`,
        title,
        detail: `${who} assigned it to you`,
        url: item.url,
        createdAt: activity.created_at,
      });
    } else if (activity.field === "state" && mine) {
      found.push({
        id: `act:${activity.id}`,
        title,
        detail: `${who} moved it: ${activity.old_value ?? "?"} → ${activity.new_value ?? "?"}`,
        url: item.url,
        createdAt: activity.created_at,
      });
    }
  }

  for (const comment of comments) {
    const author = comment.actor ?? comment.created_by ?? null;
    if (comment.created_at <= since || !author || author === me) continue;
    const html = comment.comment_html ?? "";
    const mentioned = html.includes(me);
    if (!mentioned && !mine) continue;
    const excerpt = stripHtml(html).slice(0, 160);
    const who = nameOf(author);
    found.push({
      id: `cmt:${comment.id}`,
      title,
      detail: mentioned ? `${who} mentioned you: ${excerpt}` : `${who} commented: ${excerpt}`,
      url: item.url,
      createdAt: comment.created_at,
    });
  }
  return found;
}

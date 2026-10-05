import { CLOSED_STATE_TYPES, type Issue, type Label, type Project, type User } from "./contracts";

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export const SORT_KEYS = ["priority", "updated", "created", "due", "identifier", "title"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  priority: "Priority",
  updated: "Recently updated",
  created: "Newest",
  due: "Due date",
  identifier: "Identifier",
  title: "Title",
};

/** Priority ranks: 1 urgent … 4 low, 0 none. None sorts last. */
export function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

function identifierParts(identifier: string): [string, number] {
  const dash = identifier.lastIndexOf("-");
  if (dash < 0) return [identifier, 0];
  return [identifier.slice(0, dash), Number(identifier.slice(dash + 1)) || 0];
}

function compareIdentifier(a: string, b: string): number {
  const [keyA, numA] = identifierParts(a);
  const [keyB, numB] = identifierParts(b);
  return keyA.localeCompare(keyB) || numA - numB;
}

const byUpdatedDesc = (a: Issue, b: Issue) => b.updatedAt.localeCompare(a.updatedAt);

const COMPARATORS: Record<SortKey, (a: Issue, b: Issue) => number> = {
  priority: (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byUpdatedDesc(a, b),
  updated: byUpdatedDesc,
  created: (a, b) => b.createdAt.localeCompare(a.createdAt),
  due: (a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate) || byUpdatedDesc(a, b);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return byUpdatedDesc(a, b);
  },
  identifier: (a, b) => compareIdentifier(a.identifier, b.identifier),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
};

export function sortIssues(issues: readonly Issue[], sort: SortKey): Issue[] {
  return [...issues].sort(COMPARATORS[sort]);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export const ASSIGNEE_FILTERS = ["any", "me", "unassigned", "me-or-unassigned"] as const;
export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number];

export const ASSIGNEE_FILTER_LABELS: Record<AssigneeFilter, string> = {
  any: "Everyone",
  me: "Assigned to me",
  unassigned: "Unassigned",
  "me-or-unassigned": "Mine or unassigned",
};

export const DUE_FILTERS = ["any", "overdue", "today", "week", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
  any: "Due date",
  overdue: "Overdue",
  today: "Due by today",
  week: "Due within 7 days",
  none: "No due date",
};

/** Facet value for work items without an estimate. */
export const NO_ESTIMATE = "";

export interface IssueFilters {
  /** Plane project ids. Empty = all. */
  projectIds: string[];
  /** Workflow state ids (exact states). Empty = all. */
  stateIds: string[];
  /** Workflow state types (triage/backlog/…); combined with stateIds by OR. Empty = all. */
  stateTypes: string[];
  assignee: AssigneeFilter;
  /** Specific assignee user ids; applies when `assignee` is "any". Empty = all. */
  assigneeIds: string[];
  /** Priority ranks. Empty = all. */
  priorities: number[];
  labelIds: string[];
  due: DueFilter;
  /** Estimate values ("2", "XS"); NO_ESTIMATE matches unestimated items. Empty = all. */
  estimates: string[];
  /** Only work items the viewer created. */
  createdByMe: boolean;
  /** Only work items in the viewer's sprint starting on this date, e.g. "2026-10-12" (needs the sprint ids; see IssueQuery). */
  sprint: string | null;
  /** Whose sprint `sprint` refers to: a user id, or null for the viewer. */
  sprintUserId: string | null;
  includeClosed: boolean;
}

export const EMPTY_FILTERS: IssueFilters = {
  projectIds: [],
  stateIds: [],
  stateTypes: [],
  assignee: "any",
  assigneeIds: [],
  priorities: [],
  labelIds: [],
  due: "any",
  estimates: [],
  createdByMe: false,
  sprint: null,
  sprintUserId: null,
  includeClosed: false,
};

export function countActiveFilters(filters: IssueFilters): number {
  let count = 0;
  if (filters.projectIds.length) count++;
  if (filters.stateIds.length || filters.stateTypes.length) count++;
  if (filters.assignee !== "any" || filters.assigneeIds.length) count++;
  if (filters.priorities.length) count++;
  if (filters.labelIds.length) count++;
  if (filters.due !== "any") count++;
  if (filters.estimates.length) count++;
  if (filters.createdByMe) count++;
  if (filters.sprint) count++;
  return count;
}

/** Plane issues can have several assignees; the viewer counts if they are any of them. */
export function isAssignedTo(issue: Issue, userId: string | null): boolean {
  return Boolean(userId) && issue.assignees.some((user) => user.id === userId);
}

export function isClosed(issue: Issue): boolean {
  return CLOSED_STATE_TYPES.includes(issue.state.type as (typeof CLOSED_STATE_TYPES)[number]);
}

/** Local calendar date as YYYY-MM-DD, the format Plane uses for due dates. */
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function matchesDue(dueDate: string | null | undefined, filter: DueFilter, now: Date): boolean {
  if (filter === "any") return true;
  if (filter === "none") return !dueDate;
  if (!dueDate) return false;
  const due = dueDate.slice(0, 10);
  const today = localDate(now);
  if (filter === "overdue") return due < today;
  if (filter === "today") return due <= today;
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  return due <= localDate(week);
}

export function applyFilters(
  issues: readonly Issue[],
  filters: IssueFilters,
  viewerId: string | null,
  /** The current sprint's work item ids; without them the sprint filter is a no-op. */
  sprintIds: ReadonlySet<string> | null = null,
  now: Date = new Date(),
): Issue[] {
  const estimates = new Set(filters.estimates);
  const projects = new Set(filters.projectIds);
  const stateIds = new Set(filters.stateIds);
  const stateTypes = new Set(filters.stateTypes);
  const assignees = new Set(filters.assigneeIds);
  const priorities = new Set(filters.priorities);
  const labels = new Set(filters.labelIds);

  return issues.filter((issue) => {
    if (!filters.includeClosed && isClosed(issue)) return false;
    if (projects.size && !projects.has(issue.project.id)) return false;
    if (
      (stateIds.size || stateTypes.size) &&
      !stateIds.has(issue.state.id) &&
      !stateTypes.has(issue.state.type)
    ) {
      return false;
    }
    const unassigned = issue.assignees.length === 0;
    const mine = isAssignedTo(issue, viewerId);
    if (filters.assignee === "unassigned" && !unassigned) return false;
    if (filters.assignee === "me" && !mine) return false;
    // Without a known viewer, "mine or unassigned" degrades to just "unassigned".
    if (filters.assignee === "me-or-unassigned" && !unassigned && !mine) return false;
    if (filters.assignee === "any" && assignees.size) {
      if (!issue.assignees.some((user) => assignees.has(user.id))) return false;
    }
    if (priorities.size && !priorities.has(issue.priority)) return false;
    if (labels.size && !issue.labels.some((label) => labels.has(label.id))) return false;
    if (!matchesDue(issue.dueDate, filters.due, now)) return false;
    if (estimates.size && !estimates.has(issue.estimate || NO_ESTIMATE)) return false;
    // Without a known viewer, "created by me" matches nothing rather than everything.
    if (filters.createdByMe && (!viewerId || issue.createdById !== viewerId)) return false;
    if (filters.sprint && sprintIds && !sprintIds.has(issue.id)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD");
}

function haystack(issue: Issue): string {
  return normalize(
    [
      issue.identifier,
      issue.title,
      issue.project.key,
      issue.project.name,
      issue.state.name,
      ...issue.assignees.flatMap((user) => [user.name, user.displayName ?? ""]),
      ...issue.labels.map((label) => label.name),
      issue.descriptionPreview ?? "",
    ].join("\n"),
  );
}

/**
 * Every whitespace-separated token must appear somewhere in the issue. An exact identifier match
 * (e.g. "eng-12") is placed first; otherwise the input order is preserved.
 */
export function searchIssues(issues: readonly Issue[], query: string): Issue[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...issues];
  const exact: Issue[] = [];
  const rest: Issue[] = [];
  const wholeQuery = normalize(query.trim());
  for (const issue of issues) {
    const text = haystack(issue);
    if (!tokens.every((token) => text.includes(token))) continue;
    if (normalize(issue.identifier) === wholeQuery) exact.push(issue);
    else rest.push(issue);
  }
  return [...exact, ...rest];
}

// ---------------------------------------------------------------------------
// Composition and facets
// ---------------------------------------------------------------------------

export interface IssueQuery {
  filters: IssueFilters;
  search: string;
  sort: SortKey;
  /** List issues assigned to the viewer before everything else (stable within each group). */
  mineFirst?: boolean;
  /** Work item ids in the sprint picked by `filters.sprint`. */
  sprintIds?: ReadonlySet<string> | null;
}

function mineFirst(issues: Issue[], viewerId: string | null): Issue[] {
  if (!viewerId) return issues;
  const mine: Issue[] = [];
  const others: Issue[] = [];
  for (const issue of issues) (isAssignedTo(issue, viewerId) ? mine : others).push(issue);
  return [...mine, ...others];
}

export function queryIssues(
  issues: readonly Issue[],
  query: IssueQuery,
  viewerId: string | null,
): Issue[] {
  const filtered = applyFilters(issues, query.filters, viewerId, query.sprintIds ?? null);
  const searched = searchIssues(filtered, query.search);
  const order = (list: Issue[]) => {
    const sorted = sortIssues(list, query.sort);
    return query.mineFirst ? mineFirst(sorted, viewerId) : sorted;
  };
  // A search with an exact identifier hit keeps it on top regardless of sort.
  if (
    query.search.trim() &&
    searched[0] &&
    normalize(searched[0].identifier) === normalize(query.search.trim())
  ) {
    const [first, ...others] = searched;
    return [first, ...order(others)];
  }
  return order(searched);
}

export interface Facet<T> {
  value: T;
  count: number;
}

export interface StateFacet {
  id: string;
  name: string;
  type: string;
  color: string | null;
  count: number;
}

export interface IssueFacets {
  projects: Facet<Project>[];
  states: StateFacet[];
  labels: Facet<Label>[];
  assignees: Facet<User>[];
  priorities: Facet<number>[];
  /** Estimate values present, NO_ESTIMATE included when some items lack one. */
  estimates: Facet<string>[];
}

const STATE_TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "cancelled"];

/** Distinct values present in `issues`, with counts, for building filter menus. */
export function deriveFacets(issues: readonly Issue[]): IssueFacets {
  const projects = new Map<string, Facet<Project>>();
  const states = new Map<string, StateFacet>();
  const labels = new Map<string, Facet<Label>>();
  const assignees = new Map<string, Facet<User>>();
  const priorities = new Map<number, Facet<number>>();
  const estimates = new Map<string, Facet<string>>();

  const bump = <K, V extends { count: number }>(map: Map<K, V>, key: K, make: () => V) => {
    const entry = map.get(key) ?? make();
    entry.count++;
    map.set(key, entry);
  };

  for (const issue of issues) {
    bump(projects, issue.project.id, () => ({ value: issue.project, count: 0 }));
    bump(states, issue.state.id, () => ({
      id: issue.state.id,
      name: issue.state.name,
      type: issue.state.type,
      color: issue.state.color ?? null,
      count: 0,
    }));
    for (const label of issue.labels) bump(labels, label.id, () => ({ value: label, count: 0 }));
    for (const user of issue.assignees) bump(assignees, user.id, () => ({ value: user, count: 0 }));
    bump(priorities, issue.priority, () => ({ value: issue.priority, count: 0 }));
    const estimate = issue.estimate || NO_ESTIMATE;
    bump(estimates, estimate, () => ({ value: estimate, count: 0 }));
  }

  const byCountThenName =
    <T>(name: (facet: Facet<T>) => string) =>
    (a: Facet<T>, b: Facet<T>) =>
      b.count - a.count || name(a).localeCompare(name(b));

  return {
    projects: [...projects.values()].sort((a, b) => a.value.key.localeCompare(b.value.key)),
    states: [...states.values()].sort(
      (a, b) =>
        STATE_TYPE_ORDER.indexOf(a.type) - STATE_TYPE_ORDER.indexOf(b.type) ||
        a.name.localeCompare(b.name),
    ),
    labels: [...labels.values()].sort(byCountThenName((f) => f.value.name)),
    assignees: [...assignees.values()].sort(byCountThenName((f) => f.value.name)),
    priorities: [...priorities.values()].sort(
      (a, b) => priorityRank(a.value) - priorityRank(b.value),
    ),
    estimates: [...estimates.values()].sort(compareEstimates),
  };
}

/** Numbers ascending, then categories in size order (XS…XXL), then anything else; none last. */
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
function compareEstimates(a: Facet<string>, b: Facet<string>): number {
  const rank = (value: string): [number, number, string] => {
    if (value === NO_ESTIMATE) return [3, 0, ""];
    const number = Number(value);
    if (value.trim() !== "" && Number.isFinite(number)) return [0, number, ""];
    const size = SIZE_ORDER.indexOf(value.toUpperCase());
    return size >= 0 ? [1, size, ""] : [2, 0, value];
  };
  const [ga, na, sa] = rank(a.value);
  const [gb, nb, sb] = rank(b.value);
  return ga - gb || na - nb || sa.localeCompare(sb);
}

export const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const STATE_TYPE_LABELS: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};

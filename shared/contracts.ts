import { defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Domain schemas (shared by the daemon handlers and the app UI)
// ---------------------------------------------------------------------------

/** Plane state groups. `type` on a state carries one of these. */
export const STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
] as const;
export type StateType = (typeof STATE_TYPES)[number];
export const CLOSED_STATE_TYPES: readonly StateType[] = ["completed", "cancelled"];

export const issueStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string().nullish(),
  position: z.number().nullish(),
});

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullish(),
  avatarUrl: z.string().nullish(),
});

export const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullish(),
});

/** A Plane project. `key` is the identifier prefix (e.g. ENG in ENG-42). */
export const projectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

export const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  branchName: z.string(),
  /** Plane priority mapped to a rank: 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low */
  priority: z.number(),
  priorityLabel: z.string(),
  /** Estimate point value as Plane stores it: "2" for points, "XS" for categories. */
  estimate: z.string().nullish(),
  dueDate: z.string().nullish(),
  /** Member id of whoever created the work item. */
  createdById: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullish(),
  state: issueStateSchema,
  project: projectSchema,
  assignees: z.array(userSchema),
  labels: z.array(labelSchema),
  /** Known only after the detail query; null in list rows. */
  commentCount: z.number().nullish(),
  /** First ~2 KB of the description, for local search and row previews. */
  descriptionPreview: z.string().nullish(),
});

export const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  user: userSchema.nullish(),
});

export const attachmentSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  url: z.string(),
  sourceType: z.string().nullish(),
});

export const issueImageSchema = z.object({
  url: z.string(),
  alt: z.string().nullish(),
  source: z.enum(["description", "comment", "attachment"]),
  commentId: z.string().nullish(),
  mimeType: z.string().nullish(),
  /** Base64 image bytes. Absent when the download failed; see `error`. */
  data: z.string().nullish(),
  error: z.string().nullish(),
});

export const issueDetailSchema = issueSchema.extend({
  description: z.string().nullish(),
  creator: userSchema.nullish(),
  cycle: z.object({ id: z.string(), name: z.string() }).nullish(),
  parent: z.object({ identifier: z.string(), title: z.string(), url: z.string() }).nullish(),
  comments: z.array(commentSchema),
  attachments: z.array(attachmentSchema),
  images: z.array(issueImageSchema),
});

export const credentialsStatusSchema = z.object({
  configured: z.boolean(),
  source: z.enum(["env", "file"]).nullable(),
  viewer: z.object({ id: z.string(), name: z.string(), email: z.string().nullish() }).nullish(),
  /** Workspace display name, e.g. "Aight Technologies". */
  workspace: z.string().nullish(),
  instanceUrl: z.string().nullish(),
  workspaceSlug: z.string().nullish(),
  error: z.string().nullish(),
});

export type Issue = z.output<typeof issueSchema>;
export type IssueDetail = z.output<typeof issueDetailSchema>;
export type IssueComment = z.output<typeof commentSchema>;
export type IssueImage = z.output<typeof issueImageSchema>;
export type IssueState = z.output<typeof issueStateSchema>;
export type User = z.output<typeof userSchema>;
export type Label = z.output<typeof labelSchema>;
export type Project = z.output<typeof projectSchema>;
export type CredentialsStatus = z.output<typeof credentialsStatusSchema>;

// ---------------------------------------------------------------------------
// RPC contracts
// ---------------------------------------------------------------------------

export const credentialsStatus = defineRpc({
  name: "plane.credentials.status",
  input: z.object({}),
  output: credentialsStatusSchema,
});

export const credentialsSet = defineRpc({
  name: "plane.credentials.set",
  input: z.object({
    token: z.string().min(1),
    /** Defaults to https://plane.aight.to. */
    instanceUrl: z.string().url().optional(),
    /** Defaults to "aight". */
    workspaceSlug: z.string().min(1).optional(),
  }),
  output: credentialsStatusSchema,
});

export const credentialsClear = defineRpc({
  name: "plane.credentials.clear",
  input: z.object({}),
  output: credentialsStatusSchema,
});

export const issuesList = defineRpc({
  name: "plane.issues.list",
  input: z.object({
    refresh: z.boolean().optional(),
    includeClosed: z.boolean().optional(),
  }),
  output: z.object({
    issues: z.array(issueSchema),
    projects: z.array(projectSchema),
    viewer: z.object({ id: z.string(), name: z.string() }).nullish(),
    fetchedAt: z.string(),
    /** True when more issues exist beyond the page cap. */
    truncated: z.boolean(),
  }),
});

export const issuesSearch = defineRpc({
  name: "plane.issues.search",
  input: z.object({ term: z.string().min(1) }),
  output: z.object({ issues: z.array(issueSchema) }),
});

export const issueDetail = defineRpc({
  name: "plane.issue.detail",
  input: z.object({ issueId: z.string(), projectId: z.string() }),
  output: issueDetailSchema,
});

export const issueStart = defineRpc({
  name: "plane.issue.start",
  input: z.object({
    issueId: z.string(),
    projectId: z.string(),
    moveToStarted: z.boolean(),
    assignToMe: z.boolean(),
    comment: z.string(),
  }),
  output: z.object({
    moved: z.boolean(),
    assigned: z.boolean(),
    commented: z.boolean(),
    warnings: z.array(z.string()),
  }),
});

export const projectMembers = defineRpc({
  name: "plane.project.members",
  input: z.object({ projectId: z.string() }),
  output: z.object({ members: z.array(userSchema) }),
});

export const issueSetAssignees = defineRpc({
  name: "plane.issue.assignees.set",
  input: z.object({
    issueId: z.string(),
    projectId: z.string(),
    /** The complete new assignee list; an empty list unassigns everyone. */
    assigneeIds: z.array(z.string()),
  }),
  output: z.object({ assignees: z.array(userSchema) }),
});

export const projectStates = defineRpc({
  name: "plane.project.states",
  input: z.object({ projectId: z.string() }),
  /** Ordered by group (backlog → cancelled), then Plane's own sequence. */
  output: z.object({ states: z.array(issueStateSchema) }),
});

export const issueSetState = defineRpc({
  name: "plane.issue.state.set",
  input: z.object({ issueId: z.string(), projectId: z.string(), stateId: z.string() }),
  output: z.object({ state: issueStateSchema }),
});

export const mySprintSchema = z.object({
  label: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  isCurrent: z.boolean(),
  /** Story points planned / in the unplanned-work buffer / finished, against the person's capacity. */
  plannedPoints: z.number(),
  bufferPoints: z.number(),
  donePoints: z.number(),
  capacity: z.number(),
  bufferCapacity: z.number(),
  /** Stories in the sprint without an estimate. */
  unestimated: z.number(),
  /** Work item ids in this sprint. */
  issueIds: z.array(z.string()),
});
export type MySprint = z.output<typeof mySprintSchema>;

/**
 * Recent, current and next sprints, oldest first: the viewer's, or `userId`'s when given. Empty on
 * Plane builds without the sprint-capacity endpoint.
 */
export const sprintMine = defineRpc({
  name: "plane.sprint.mine",
  input: z.object({ userId: z.string().nullish() }),
  output: z.object({ sprints: z.array(mySprintSchema) }),
});

export const sprintPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  isMe: z.boolean(),
});
export type SprintPerson = z.output<typeof sprintPersonSchema>;

/** People whose sprint the viewer may open (everyone sharing a workspace). Empty without the fork. */
export const sprintPeople = defineRpc({
  name: "plane.sprint.people",
  input: z.object({}),
  output: z.object({ people: z.array(sprintPersonSchema) }),
});

/** Lets app-side failures (which never reach the daemon otherwise) show in `paseo plugin logs`. */
export const clientLog = defineRpc({
  name: "plane.client.log",
  input: z.object({
    level: z.enum(["info", "warn", "error"]),
    message: z.string().max(4000),
  }),
  output: z.object({}),
});

export const attachmentsSearch = defineRpc({
  name: "plane.attachments.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export type IssuesListResult = z.output<typeof issuesList.output>;
export type IssueStartResult = z.output<typeof issueStart.output>;

// ---------------------------------------------------------------------------
// Error conventions. RPC failures reach the app as plain Error messages, so the
// daemon marks "no token yet" with a stable phrase the UI can recognise.
// ---------------------------------------------------------------------------

export const NOT_CONFIGURED_MESSAGE =
  "Plane is not configured. Add a personal API token under Settings → Plugins → Plane.";

export function isNotConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Plane is not configured");
}

export function isAuthError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /rejected the API token|lacks permission|authentication/i.test(error.message)
  );
}

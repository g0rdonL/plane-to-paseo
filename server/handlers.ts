import type { PluginAttachmentItem, RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  attachmentsSearch,
  clientLog,
  credentialsClear,
  credentialsSet,
  credentialsStatus,
  issueDetail,
  issueSetAssignees,
  issueSetState,
  issueStart,
  issuesList,
  issuesSearch,
  projectMembers,
  projectStates,
  sprintMine,
  sprintPeople,
} from "../shared/contracts";
import { NOT_CONFIGURED_MESSAGE } from "../shared/contracts";
import { assigneeNames, issueSummaryText } from "../shared/prompt";
import {
  clearCredentials,
  DEFAULT_INSTANCE_URL,
  DEFAULT_WORKSPACE_SLUG,
  type ResolvedCredentials,
  resolveCredentials,
  saveCredentials,
} from "./credentials";
import { createPlaneClient, normalizeInstanceUrl } from "./plane/client";
import { PlaneService } from "./plane/service";

type Status = RpcOutput<typeof credentialsStatus>;

let active: { key: string; service: PlaneService } | null = null;

function createService(credentials: Omit<ResolvedCredentials, "source">): PlaneService {
  return new PlaneService({
    client: createPlaneClient({ token: credentials.token, instanceUrl: credentials.instanceUrl }),
    workspaceSlug: credentials.workspaceSlug,
  });
}

function serviceFor(credentials: ResolvedCredentials): PlaneService {
  const key = `${credentials.instanceUrl}\n${credentials.workspaceSlug}\n${credentials.token}`;
  if (!active || active.key !== key) active = { key, service: createService(credentials) };
  return active.service;
}

function requireService(): PlaneService {
  const resolved = resolveCredentials();
  if (!resolved) throw new Error(NOT_CONFIGURED_MESSAGE);
  return serviceFor(resolved);
}

async function describeStatus(): Promise<Status> {
  const resolved = resolveCredentials();
  if (!resolved) {
    return {
      configured: false,
      source: null,
      viewer: null,
      workspace: null,
      instanceUrl: null,
      workspaceSlug: null,
      error: null,
    };
  }
  const base = {
    configured: true,
    source: resolved.source,
    workspace: resolved.workspaceSlug,
    instanceUrl: resolved.instanceUrl,
    workspaceSlug: resolved.workspaceSlug,
  };
  try {
    const { viewer } = await serviceFor(resolved).bootstrap(true);
    return {
      ...base,
      viewer: { id: viewer.id, name: viewer.name, email: viewer.email },
      error: null,
    };
  } catch (error) {
    return { ...base, viewer: null, error: (error as Error).message };
  }
}

export async function credentialsStatusHandler(
  _input: RpcInput<typeof credentialsStatus>,
): Promise<Status> {
  return describeStatus();
}

export async function credentialsSetHandler(
  input: RpcInput<typeof credentialsSet>,
): Promise<Status> {
  const credentials = {
    token: input.token.trim(),
    instanceUrl: normalizeInstanceUrl(input.instanceUrl ?? DEFAULT_INSTANCE_URL),
    workspaceSlug: (input.workspaceSlug ?? DEFAULT_WORKSPACE_SLUG).trim(),
  };
  // Validate before persisting so a typo never replaces a working token. Listing projects also
  // proves the token can read the chosen workspace, not just authenticate.
  const probe = await createService(credentials).bootstrap(true);
  saveCredentials(credentials);
  active = null;
  const status = await describeStatus();
  if (status.source === "env") {
    return {
      ...status,
      error: `Saved, but PLANE_API_KEY is set in the daemon environment and takes precedence (the saved token belongs to ${probe.viewer.name}).`,
    };
  }
  return status;
}

export async function credentialsClearHandler(
  _input: RpcInput<typeof credentialsClear>,
): Promise<Status> {
  clearCredentials();
  active = null;
  return describeStatus();
}

export function issuesListHandler(
  input: RpcInput<typeof issuesList>,
): Promise<RpcOutput<typeof issuesList>> {
  return requireService().listIssues({
    includeClosed: input.includeClosed ?? false,
    refresh: input.refresh ?? false,
  });
}

export async function issuesSearchHandler(
  input: RpcInput<typeof issuesSearch>,
): Promise<RpcOutput<typeof issuesSearch>> {
  return { issues: await requireService().searchIssues(input.term) };
}

export function issueDetailHandler(
  input: RpcInput<typeof issueDetail>,
): Promise<RpcOutput<typeof issueDetail>> {
  return requireService().issueDetail(input);
}

export function issueStartHandler(
  input: RpcInput<typeof issueStart>,
): Promise<RpcOutput<typeof issueStart>> {
  console.log(
    `[plane-to-paseo] start issue=${input.issueId} move=${input.moveToStarted} assign=${input.assignToMe}`,
  );
  return requireService().startIssue(input);
}

export async function projectMembersHandler(
  input: RpcInput<typeof projectMembers>,
): Promise<RpcOutput<typeof projectMembers>> {
  return { members: await requireService().projectMembers(input.projectId) };
}

export function issueSetAssigneesHandler(
  input: RpcInput<typeof issueSetAssignees>,
): Promise<RpcOutput<typeof issueSetAssignees>> {
  console.log(
    `[plane-to-paseo] set assignees issue=${input.issueId} count=${input.assigneeIds.length}`,
  );
  return requireService().setAssignees(input);
}

export async function projectStatesHandler(
  input: RpcInput<typeof projectStates>,
): Promise<RpcOutput<typeof projectStates>> {
  return { states: await requireService().projectStates(input.projectId) };
}

export function issueSetStateHandler(
  input: RpcInput<typeof issueSetState>,
): Promise<RpcOutput<typeof issueSetState>> {
  console.log(`[plane-to-paseo] set state issue=${input.issueId} state=${input.stateId}`);
  return requireService().setState(input);
}

export async function sprintMineHandler(
  input: RpcInput<typeof sprintMine>,
): Promise<RpcOutput<typeof sprintMine>> {
  return { sprints: await requireService().mySprints(input.userId) };
}

export async function sprintPeopleHandler(
  _input: RpcInput<typeof sprintPeople>,
): Promise<RpcOutput<typeof sprintPeople>> {
  return { people: await requireService().sprintPeople() };
}

export async function clientLogHandler(
  input: RpcInput<typeof clientLog>,
): Promise<RpcOutput<typeof clientLog>> {
  const line = `[plane-to-paseo:app] ${input.message}`;
  if (input.level === "error") console.error(line);
  else if (input.level === "warn") console.warn(line);
  else console.log(line);
  return {};
}

export async function attachmentsSearchHandler(
  input: RpcInput<typeof attachmentsSearch>,
): Promise<RpcOutput<typeof attachmentsSearch>> {
  const service = requireService();
  const term = input.query.trim();
  const issues = term
    ? await service.searchIssues(term, 20)
    : (await service.listIssues({ includeClosed: false, refresh: false })).issues.slice(0, 20);
  const items: PluginAttachmentItem[] = issues.map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    subtitle: [issue.state.name, assigneeNames(issue)].filter(Boolean).join(" · "),
    url: issue.url,
    text: issueSummaryText(issue),
    resourceType: "issue",
  }));
  return { items };
}

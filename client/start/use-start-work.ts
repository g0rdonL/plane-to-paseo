import type { PaseoApi } from "@getpaseo/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { IssueDetail } from "../../shared/contracts";

export type StartTarget =
  | {
      kind: "new-worktree";
      projectId: string;
      projectRootPath: string;
      projectName: string;
      branchName: string;
      baseBranch: string | null;
    }
  | { kind: "workspace"; workspaceId: string; name: string };

export interface StartWorkInput {
  detail: IssueDetail;
  prompt: string;
  /** `provider/model` */
  model: string;
  /** Provider mode id (e.g. auto, bypassPermissions); omitted = provider's built-in default. */
  modeId: string | null;
  target: StartTarget;
  attachImages: boolean;
}

export interface StartWorkOutcome {
  workspaceId: string | null;
  agentId: string;
  branchName: string | null;
  navigated: boolean;
}

const TITLE_LIMIT = 80;

export function agentTitle(detail: IssueDetail): string {
  const title = `${detail.identifier} ${detail.title}`.trim();
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

/**
 * Creates the workspace (when asked), then the agent with the ticket as its first message, then
 * navigates. Plane write-back is the caller's job and runs only after this resolves, so a Plane
 * failure can never cost the hand-off.
 */
export async function startWork(
  paseo: PaseoApi,
  navigation: PluginSurfaceProps["navigation"] | undefined,
  input: StartWorkInput,
): Promise<StartWorkOutcome> {
  const { detail, target } = input;
  const title = agentTitle(detail);

  const workspace =
    target.kind === "new-worktree"
      ? await paseo.workspaces.create({
          title,
          firstAgentContext: { prompt: input.prompt },
          source: {
            kind: "worktree",
            projectId: target.projectId,
            cwd: target.projectRootPath,
            action: "branch-off",
            branchName: target.branchName,
            ...(target.baseBranch ? { baseBranch: target.baseBranch } : {}),
          },
        })
      : paseo.workspaces.ref(target.workspaceId);

  const images = input.attachImages
    ? detail.images
        .filter((image) => image.data && image.mimeType)
        .map((image) => ({ data: image.data as string, mimeType: image.mimeType as string }))
    : [];

  const agent = await workspace.agents.create({
    config: { provider: input.model, ...(input.modeId ? { modeId: input.modeId } : {}) },
    title,
    prompt: input.prompt,
    ...(images.length > 0 ? { images } : {}),
    labels: { plane: detail.identifier },
  });

  let navigated = false;
  if (navigation) {
    try {
      navigation.openAgent({ agentId: agent.id });
      navigated = true;
    } catch {
      try {
        navigation.openWorkspace({ workspaceId: workspace.id });
        navigated = true;
      } catch {
        navigated = false;
      }
    }
  }

  return {
    workspaceId: workspace.id,
    agentId: agent.id,
    branchName: target.kind === "new-worktree" ? target.branchName : null,
    navigated,
  };
}

export function handoffComment(outcome: StartWorkOutcome, target: StartTarget): string {
  const where =
    target.kind === "new-worktree"
      ? `in a new worktree of **${target.projectName}** on branch \`${target.branchName}\``
      : `in workspace **${target.name}**`;
  return `Picked up in Paseo ${where} (agent \`${outcome.agentId}\`).`;
}

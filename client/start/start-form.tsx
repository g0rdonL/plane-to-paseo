import type { PaseoProject, PaseoProviderSnapshotResult, PaseoWorkspace } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { IssueDetail } from "../../shared/contracts";
import { assigneeNames, hydratePrompt } from "../../shared/prompt";
import type { Preferences } from "../../shared/settings";
import { useClientLog, useIssueStartMutation } from "../queries";
import { Button, Chip, ErrorText, Muted, SectionTitle, Spinner, Toggle } from "../ui";
import { handoffComment, type StartTarget, startWork } from "./use-start-work";

export interface StartFormProps {
  theme: PluginTheme;
  compact: boolean;
  detail: IssueDetail;
  navigation?: PluginSurfaceProps["navigation"];
  fixedWorkspaceId?: string;
  preferences: Preferences;
  savePreferences?: (values: Partial<Preferences>) => Promise<boolean>;
  onStarted(summary: string): void;
}

interface ModelChoice {
  value: string;
  label: string;
  isDefault: boolean;
}

function modelChoices(snapshot: PaseoProviderSnapshotResult): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const entry of snapshot.entries) {
    if (entry.status !== "ready" || entry.enabled === false) continue;
    const providerLabel = entry.label ?? entry.provider;
    for (const model of entry.models ?? []) {
      if (model.isSelectable === false) continue;
      choices.push({
        value: `${entry.provider}/${model.id}`,
        label: `${providerLabel} · ${model.label}`,
        isDefault: model.isDefault === true,
      });
    }
  }
  return choices;
}

type TargetMode = "new-worktree" | "workspace";

interface ModeChoice {
  id: string;
  label: string;
  description: string | null;
}

/** Modes that skip permission prompts entirely. */
function isUnguardedMode(mode: ModeChoice): boolean {
  return /bypass|allow.?all|yolo|full/i.test(`${mode.id} ${mode.label}`);
}

export function StartForm({
  theme,
  compact,
  detail,
  navigation,
  fixedWorkspaceId,
  preferences,
  savePreferences,
  onStarted,
}: StartFormProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const writeBack = useIssueStartMutation();
  const log = useClientLog();

  const projectsQuery = useQuery({
    queryKey: ["paseo", "projects"],
    queryFn: () => paseo.projects.list(),
    staleTime: 30_000,
  });
  const workspacesQuery = useQuery({
    queryKey: ["paseo", "workspaces"],
    queryFn: () => paseo.workspaces.list(),
    staleTime: 15_000,
  });

  const projects = useMemo(
    () => (projectsQuery.data?.projects ?? []).filter((project) => project.projectKind === "git"),
    [projectsQuery.data],
  );
  const workspaces = useMemo(
    () =>
      (workspacesQuery.data?.entries ?? []).filter(
        (workspace) => workspace.workspaceDirectory && !workspace.archivingAt,
      ),
    [workspacesQuery.data],
  );
  const fixedWorkspace = useMemo(
    () =>
      fixedWorkspaceId
        ? (workspaces.find((workspace) => workspace.id === fixedWorkspaceId) ?? null)
        : null,
    [workspaces, fixedWorkspaceId],
  );

  const [mode, setMode] = useState<TargetMode>(fixedWorkspaceId ? "workspace" : "new-worktree");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(fixedWorkspaceId ?? null);
  const [branchName, setBranchName] = useState(detail.branchName);
  const [model, setModel] = useState<string | null>(preferences.defaultModel);
  const [prompt, setPrompt] = useState(() => hydratePrompt(preferences.promptTemplate, detail));
  const [moveToStarted, setMoveToStarted] = useState(preferences.moveToStarted);
  const [assignToMe, setAssignToMe] = useState(
    preferences.assignToMe && detail.assignees.length === 0,
  );
  const [attachImages, setAttachImages] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [picker, setPicker] = useState<"project" | "workspace" | "model" | "mode" | null>(null);

  // Default project: the last one used, then the fixed workspace's project, then the first.
  useEffect(() => {
    if (projectId || projects.length === 0) return;
    const remembered = projects.find(
      (project) => project.projectRootPath === preferences.lastProjectPath,
    );
    const fromWorkspace = fixedWorkspace
      ? projects.find((project) => project.projectId === fixedWorkspace.projectId)
      : null;
    setProjectId((remembered ?? fromWorkspace ?? projects[0])?.projectId ?? null);
  }, [projects, projectId, preferences.lastProjectPath, fixedWorkspace]);

  const selectedProject: PaseoProject | null =
    projects.find((project) => project.projectId === projectId) ?? null;
  const selectedWorkspace: PaseoWorkspace | null =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const cwd =
    mode === "workspace" ? selectedWorkspace?.workspaceDirectory : selectedProject?.projectRootPath;

  const providersQuery = useQuery({
    queryKey: ["paseo", "providers", cwd ?? ""],
    queryFn: () => paseo.providers.snapshot(cwd ? { cwd } : undefined),
    staleTime: 60_000,
  });
  const models = useMemo(
    () => (providersQuery.data ? modelChoices(providersQuery.data) : null),
    [providersQuery.data],
  );
  useEffect(() => {
    if (!models || models.length === 0) return;
    if (model && models.some((choice) => choice.value === model)) return;
    setModel((models.find((choice) => choice.isDefault) ?? models[0])?.value ?? null);
  }, [models, model]);

  // Modes belong to the provider of the chosen model. Default: the last mode used with that
  // provider, then the provider's own default (auto for Claude), then its first mode.
  const provider = model ? model.split("/")[0] : null;
  const providerEntry = useMemo(
    () => providersQuery.data?.entries.find((entry) => entry.provider === provider) ?? null,
    [providersQuery.data, provider],
  );
  const modes: ModeChoice[] = useMemo(
    () =>
      (providerEntry?.modes ?? []).map((mode) => ({
        id: mode.id,
        label: mode.label,
        description: mode.description ?? null,
      })),
    [providerEntry],
  );
  useEffect(() => {
    if (modes.length === 0) {
      if (modeId !== null) setModeId(null);
      return;
    }
    if (modeId && modes.some((mode) => mode.id === modeId)) return;
    const remembered = provider ? preferences.defaultModes[provider] : undefined;
    const pick =
      modes.find((mode) => mode.id === remembered) ??
      modes.find((mode) => mode.id === providerEntry?.defaultModeId) ??
      modes[0];
    setModeId(pick?.id ?? null);
  }, [modes, modeId, provider, providerEntry, preferences.defaultModes]);
  const selectedMode = modes.find((mode) => mode.id === modeId) ?? null;

  const attachedImageCount = detail.images.filter((image) => image.data).length;

  const target: StartTarget | null =
    mode === "new-worktree"
      ? selectedProject && branchName.trim()
        ? {
            kind: "new-worktree",
            projectId: selectedProject.projectId,
            projectRootPath: selectedProject.projectRootPath,
            projectName: selectedProject.projectDisplayName,
            branchName: branchName.trim(),
            baseBranch: null,
          }
        : null
      : selectedWorkspace
        ? { kind: "workspace", workspaceId: selectedWorkspace.id, name: selectedWorkspace.name }
        : null;

  const fail = (message: string) => {
    setFailure(message);
    log("warn", `${detail.identifier}: ${message}`);
  };

  const start = async () => {
    log(
      "info",
      `${detail.identifier}: start pressed mode=${mode} model=${model ?? "none"} mode=${modeId ?? "provider-default"} project=${selectedProject?.projectDisplayName ?? "none"} workspace=${selectedWorkspace?.name ?? "none"} models=${models?.length ?? "loading"} projects=${projects.length} providersError=${providersQuery.error ? (providersQuery.error as Error).message : "none"}`,
    );
    if (!model)
      return fail("Pick a model first. Enable a provider in Paseo settings if the list is empty.");
    if (!target)
      return fail(
        mode === "new-worktree" ? "Pick a project and a branch name." : "Pick a workspace.",
      );
    if (!prompt.trim()) return fail("The prompt is empty.");
    setFailure(null);
    setBusy(target.kind === "new-worktree" ? "Creating worktree workspace…" : "Starting agent…");
    try {
      const outcome = await startWork(paseo, navigation, {
        detail,
        prompt,
        model,
        modeId,
        target,
        attachImages,
      });
      if (savePreferences) {
        void savePreferences({
          defaultModel: model,
          ...(provider && modeId
            ? { defaultModes: { ...preferences.defaultModes, [provider]: modeId } }
            : {}),
          lastProjectPath:
            target.kind === "new-worktree" ? target.projectRootPath : preferences.lastProjectPath,
        });
      }
      setBusy("Updating Plane…");
      let summary = `Agent started for ${detail.identifier}.`;
      try {
        const result = await writeBack.mutateAsync({
          issueId: detail.id,
          projectId: detail.project.id,
          moveToStarted,
          assignToMe,
          comment: handoffComment(outcome, target),
        });
        const done = [
          result.moved ? "moved to In Progress" : null,
          result.assigned ? "assigned to you" : null,
          result.commented ? "commented" : null,
        ]
          .filter(Boolean)
          .join(", ");
        if (done) summary += ` Plane: ${done}.`;
        for (const warning of result.warnings)
          toast.show(warning, { variant: "warning", durationMs: 5000 });
      } catch (error) {
        toast.error(`Agent started, but Plane was not updated: ${(error as Error).message}`);
      }
      if (!outcome.navigated) summary += " Open it from the workspace list.";
      onStarted(summary);
    } catch (error) {
      const err = error as Error;
      fail(`Hand-off failed: ${err.message}`);
      log("error", `${detail.identifier}: ${err.stack ?? err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const inputStyle = {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  } as const;

  const pickerRows = (): Array<{
    id: string;
    label: string;
    hint?: string;
    selected: boolean;
    onSelect(): void;
  }> => {
    if (picker === "project") {
      return projects.map((project) => ({
        id: project.projectId,
        label: project.projectDisplayName,
        hint: project.projectRootPath,
        selected: project.projectId === projectId,
        onSelect: () => setProjectId(project.projectId),
      }));
    }
    if (picker === "workspace") {
      return workspaces.map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        hint: `${workspace.projectDisplayName} · ${workspace.workspaceDirectory ?? ""}`,
        selected: workspace.id === workspaceId,
        onSelect: () => setWorkspaceId(workspace.id),
      }));
    }
    if (picker === "model") {
      return (models ?? []).map((choice) => ({
        id: choice.value,
        label: choice.label,
        hint: choice.isDefault ? "Paseo default" : undefined,
        selected: choice.value === model,
        onSelect: () => setModel(choice.value),
      }));
    }
    if (picker === "mode") {
      return modes.map((mode) => ({
        id: mode.id,
        label: mode.label,
        hint: isUnguardedMode(mode)
          ? "No approval prompts: the agent acts on the ticket text unchecked."
          : (mode.description ??
            (mode.id === providerEntry?.defaultModeId ? "Provider default" : undefined)),
        selected: mode.id === modeId,
        onSelect: () => setModeId(mode.id),
      }));
    }
    return [];
  };

  const inlineList = (kind: "project" | "workspace" | "model" | "mode") => {
    if (picker !== kind) return null;
    const rows = pickerRows();
    return (
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          backgroundColor: theme.colors.surface0,
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <Muted theme={theme} style={{ padding: 12 }}>
            Nothing available.
          </Muted>
        ) : null}
        {rows.map((row, index) => (
          <Pressable
            key={row.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: row.selected }}
            onPress={() => {
              row.onSelect();
              setPicker(null);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: theme.colors.border,
              backgroundColor: pressed ? theme.colors.surface1 : "transparent",
            })}
          >
            <Icon
              name={row.selected ? "CircleDot" : "Circle"}
              size={16}
              color={row.selected ? theme.colors.accent : theme.colors.foregroundMuted}
            />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{row.label}</Text>
              {row.hint ? (
                <Muted theme={theme} style={{ fontSize: 11 }}>
                  {row.hint}
                </Muted>
              ) : null}
            </View>
          </Pressable>
        ))}
      </View>
    );
  };

  return (
    <View
      style={{
        gap: 6,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <SectionTitle theme={theme}>Where</SectionTitle>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Chip
          theme={theme}
          icon="GitBranch"
          label="New worktree workspace"
          selected={mode === "new-worktree"}
          onPress={() => setMode("new-worktree")}
        />
        <Chip
          theme={theme}
          icon="Folder"
          label={fixedWorkspace ? "This workspace" : "Existing workspace"}
          selected={mode === "workspace"}
          onPress={() => setMode("workspace")}
        />
      </View>

      {mode === "new-worktree" ? (
        <View style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPicker(picker === "project" ? null : "project")}
            style={[inputStyle, { flexDirection: "row", alignItems: "center", gap: 8 }]}
          >
            <Icon name="FolderGit2" size={15} color={theme.colors.foregroundMuted} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {projectsQuery.isLoading
                  ? "Loading projects…"
                  : (selectedProject?.projectDisplayName ?? "Choose a project")}
              </Text>
              {selectedProject ? (
                <Muted theme={theme}>{selectedProject.projectRootPath}</Muted>
              ) : null}
            </View>
            <Icon name="ChevronDown" size={15} color={theme.colors.foregroundMuted} />
          </Pressable>
          {inlineList("project")}
          {projects.length === 0 && !projectsQuery.isLoading ? (
            <Muted theme={theme}>
              No git projects in Paseo yet. Add one from the Paseo sidebar first.
            </Muted>
          ) : null}
          <View>
            <Muted theme={theme} style={{ marginBottom: 4 }}>
              Branch (from Plane)
            </Muted>
            <TextInput
              value={branchName}
              onChangeText={setBranchName}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Branch name"
              placeholder="branch-name"
              placeholderTextColor={theme.colors.foregroundMuted}
            />
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            fixedWorkspaceId ? null : setPicker(picker === "workspace" ? null : "workspace")
          }
          style={[inputStyle, { flexDirection: "row", alignItems: "center", gap: 8 }]}
        >
          <Icon name="Folder" size={15} color={theme.colors.foregroundMuted} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              {workspacesQuery.isLoading
                ? "Loading workspaces…"
                : (selectedWorkspace?.name ?? "Choose a workspace")}
            </Text>
            {selectedWorkspace ? (
              <Muted theme={theme}>{selectedWorkspace.workspaceDirectory}</Muted>
            ) : null}
          </View>
          {fixedWorkspaceId ? null : (
            <Icon name="ChevronDown" size={15} color={theme.colors.foregroundMuted} />
          )}
        </Pressable>
      )}

      {inlineList("workspace")}

      <SectionTitle theme={theme}>Model</SectionTitle>
      {models === null ? (
        providersQuery.error ? (
          <ErrorText theme={theme}>{(providersQuery.error as Error).message}</ErrorText>
        ) : (
          <Spinner theme={theme} />
        )
      ) : models.length === 0 ? (
        <Muted theme={theme}>
          No enabled provider with models. Configure one in Paseo settings.
        </Muted>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setPicker(picker === "model" ? null : "model")}
          style={[inputStyle, { flexDirection: "row", alignItems: "center", gap: 8 }]}
        >
          <Icon name="Bot" size={15} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }}>
            {models.find((choice) => choice.value === model)?.label ?? "Choose a model"}
          </Text>
          <Icon name="ChevronDown" size={15} color={theme.colors.foregroundMuted} />
        </Pressable>
      )}

      {inlineList("model")}

      {modes.length > 0 ? (
        <>
          <SectionTitle theme={theme}>Mode</SectionTitle>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Agent mode: ${selectedMode?.label ?? "provider default"}. Change mode`}
            onPress={() => setPicker(picker === "mode" ? null : "mode")}
            style={[inputStyle, { flexDirection: "row", alignItems: "center", gap: 8 }]}
          >
            <Icon
              name={selectedMode && isUnguardedMode(selectedMode) ? "ShieldOff" : "Shield"}
              size={15}
              color={
                selectedMode && isUnguardedMode(selectedMode)
                  ? theme.colors.statusWarning
                  : theme.colors.foregroundMuted
              }
            />
            <Text style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }}>
              {selectedMode?.label ?? "Provider default"}
            </Text>
            <Icon name="ChevronDown" size={15} color={theme.colors.foregroundMuted} />
          </Pressable>
          {inlineList("mode")}
        </>
      ) : null}

      <SectionTitle theme={theme} trailing={<Muted theme={theme}>{prompt.length} chars</Muted>}>
        First message
      </SectionTitle>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        editable={!busy}
        style={[
          inputStyle,
          { minHeight: compact ? 160 : 220, textAlignVertical: "top", lineHeight: 18 },
        ]}
        accessibilityLabel="First message for the agent"
      />
      <Muted theme={theme}>Edit freely. The template lives in Settings → Plugins → Plane.</Muted>

      <SectionTitle theme={theme}>Options</SectionTitle>
      {detail.images.length > 0 ? (
        <Toggle
          theme={theme}
          label={`Attach ${attachedImageCount} image${attachedImageCount === 1 ? "" : "s"} from the work item`}
          hint={
            attachedImageCount < detail.images.length
              ? `${detail.images.length - attachedImageCount} could not be downloaded`
              : undefined
          }
          value={attachImages && attachedImageCount > 0}
          onChange={setAttachImages}
          disabled={attachedImageCount === 0}
        />
      ) : null}
      <Toggle
        theme={theme}
        label="Move to In Progress and comment in Plane"
        value={moveToStarted}
        onChange={setMoveToStarted}
      />
      <Toggle
        theme={theme}
        label="Assign to me"
        hint={
          detail.assignees.length ? `Currently assigned to ${assigneeNames(detail)}` : undefined
        }
        value={assignToMe}
        onChange={setAssignToMe}
      />

      {failure ? <ErrorText theme={theme}>{failure}</ErrorText> : null}
      <Button
        theme={theme}
        icon="Play"
        label={
          busy ?? (mode === "new-worktree" ? "Create workspace and start agent" : "Start agent")
        }
        onPress={() => void start()}
        busy={busy !== null}
        disabled={!model || !target || !prompt.trim()}
        style={{ marginTop: 6 }}
      />
    </View>
  );
}

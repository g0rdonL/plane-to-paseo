import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  ASSIGNEE_FILTER_LABELS,
  ASSIGNEE_FILTERS,
  SORT_KEYS,
  SORT_LABELS,
} from "../../shared/issue-query";
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_PLACEHOLDERS } from "../../shared/prompt";
import { type Preferences, preferences } from "../../shared/settings";
import { useCredentialsMutations, useCredentialsStatusQuery } from "../queries";
import { Button, Muted } from "../ui";

export function PlaneSettings({ theme }: PluginSurfaceProps) {
  const toast = useToast();
  const status = useCredentialsStatusQuery();
  const { save, remove } = useCredentialsMutations();
  const tokenInput = useRef<SettingsInputHandle>(null);
  const instanceUrlInput = useRef<SettingsInputHandle>(null);
  const workspaceSlugInput = useRef<SettingsInputHandle>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [instanceUrlDraft, setInstanceUrlDraft] = useState("");
  const [workspaceSlugDraft, setWorkspaceSlugDraft] = useState("");
  const settings = useSettings(preferences);

  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [templateRevision, setTemplateRevision] = useState<string | null>(null);
  useEffect(() => {
    if (settings.status === "ready" && templateDraft === null) {
      setTemplateDraft(settings.values.promptTemplate);
      setTemplateRevision(settings.revision);
    }
  }, [settings, templateDraft]);

  const connection = status.data;
  const connectionHint = status.isLoading
    ? "Checking…"
    : !connection?.configured
      ? "No API token yet."
      : connection.error
        ? connection.error
        : `Connected as ${connection.viewer?.name ?? "unknown"}${connection.workspace ? ` · ${connection.workspace}` : ""}${connection.instanceUrl ? ` on ${connection.instanceUrl}` : ""} (${
            connection.source === "env" ? "from PLANE_API_KEY" : "stored on the daemon"
          })`;

  const saveToken = async () => {
    const token = tokenDraft.trim();
    if (!token) return;
    try {
      const instanceUrl = instanceUrlDraft.trim();
      const workspaceSlug = workspaceSlugDraft.trim();
      const result = await save.mutateAsync({
        token,
        ...(instanceUrl ? { instanceUrl } : {}),
        ...(workspaceSlug ? { workspaceSlug } : {}),
      });
      if (result.error) toast.show(result.error, { variant: "warning", durationMs: 6000 });
      else
        toast.show(`Connected as ${result.viewer?.name ?? "Plane user"}`, { variant: "success" });
      tokenInput.current?.replaceText("");
      setTokenDraft("");
      instanceUrlInput.current?.replaceText("");
      setInstanceUrlDraft("");
      workspaceSlugInput.current?.replaceText("");
      setWorkspaceSlugDraft("");
    } catch (error) {
      toast.error(`Plane rejected the token: ${(error as Error).message}`);
    }
  };

  const update = async (patch: Partial<Preferences>) => {
    if (settings.status !== "ready") return;
    const ok = await settings.save({ ...settings.values, ...patch }, settings.revision);
    if (!ok) toast.error(settings.saveError ?? "Could not save settings");
  };

  const values = settings.status === "ready" ? settings.values : null;

  return (
    <View style={{ gap: 8 }}>
      <SettingsSection
        title="Connection"
        info="A Plane personal access token. Create one in Plane under Profile settings → Personal Access Tokens."
      >
        <SettingsCard>
          <SettingsRow
            label="Status"
            hint={connectionHint}
            error={connection?.configured && connection.error ? connection.error : null}
          />
          <SettingsInput
            ref={instanceUrlInput}
            label="Instance URL"
            hint={`Optional. Leave empty to keep ${connection?.instanceUrl ?? "the default"}.`}
            placeholder="https://plane.aight.to"
            onChangeText={setInstanceUrlDraft}
            disabled={save.isPending}
          />
          <SettingsInput
            ref={workspaceSlugInput}
            label="Workspace slug"
            hint={`Optional. Leave empty to keep ${connection?.workspaceSlug ?? "the default"}.`}
            placeholder="aight"
            onChangeText={setWorkspaceSlugDraft}
            disabled={save.isPending}
          />
          <SettingsInput
            ref={tokenInput}
            label="Personal access token"
            hint="Stored with 0600 permissions under the daemon's plugin directory. Never shared with connected clients."
            placeholder="plane_api_…"
            secureTextEntry
            onChangeText={setTokenDraft}
            disabled={save.isPending}
          />
          <SettingsAction
            label="Save token"
            hint="Validated against Plane before it replaces the current token."
            actionLabel={save.isPending ? "Saving…" : "Save"}
            onPress={() => void saveToken()}
            disabled={save.isPending || !tokenDraft.trim()}
          />
          {connection?.configured && connection.source === "file" ? (
            <SettingsAction
              label="Remove stored token"
              actionLabel={remove.isPending ? "Removing…" : "Remove"}
              onPress={() => void remove.mutateAsync().then(() => toast.show("Token removed"))}
              disabled={remove.isPending}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Work item list">
        <SettingsCard>
          <SettingsSwitch
            label="Include closed work items by default"
            value={values?.includeClosed ?? false}
            onValueChange={(includeClosed) => void update({ includeClosed })}
            disabled={!values}
          />
          <SettingsSelect
            label="Default sort"
            value={values?.defaultSort ?? "updated"}
            options={SORT_KEYS.map((key) => ({ value: key, label: SORT_LABELS[key] }))}
            onValueChange={(defaultSort) => void update({ defaultSort })}
            disabled={!values}
          />
          <SettingsSelect
            label="Default assignee filter"
            value={values?.defaultAssignee ?? "me-or-unassigned"}
            options={ASSIGNEE_FILTERS.map((key) => ({
              value: key,
              label: ASSIGNEE_FILTER_LABELS[key],
            }))}
            onValueChange={(defaultAssignee) => void update({ defaultAssignee })}
            disabled={!values}
          />
          <SettingsSwitch
            label="Show my work items first"
            value={values?.mineFirst ?? true}
            onValueChange={(mineFirst) => void update({ mineFirst })}
            disabled={!values}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Hand-off defaults">
        <SettingsCard>
          <SettingsSwitch
            label="Move work item to In Progress and comment"
            value={values?.moveToStarted ?? true}
            onValueChange={(moveToStarted) => void update({ moveToStarted })}
            disabled={!values}
          />
          <SettingsSwitch
            label="Assign unassigned work items to me"
            value={values?.assignToMe ?? true}
            onValueChange={(assignToMe) => void update({ assignToMe })}
            disabled={!values}
          />
          <SettingsRow
            label="Default model"
            hint={values?.defaultModel ?? "Paseo default; remembered from your last hand-off."}
          >
            {values?.defaultModel ? (
              <Button
                theme={theme}
                variant="secondary"
                label="Forget"
                onPress={() => void update({ defaultModel: null })}
              />
            ) : null}
          </SettingsRow>
          <SettingsRow
            label="Last project"
            hint={values?.lastProjectPath ?? "Remembered from your last hand-off."}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="First message template"
        info={`Placeholders: ${PROMPT_PLACEHOLDERS.map((key) => `{{${key}}}`).join(" ")}`}
      >
        <SettingsCard>
          <View style={{ padding: 12, gap: 8 }}>
            <TextInput
              value={templateDraft ?? ""}
              onChangeText={setTemplateDraft}
              multiline
              editable={values !== null}
              accessibilityLabel="Prompt template"
              style={{
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface1,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                padding: 10,
                fontSize: 13,
                lineHeight: 18,
                minHeight: 220,
                textAlignVertical: "top",
              }}
            />
            <Muted theme={theme}>{PROMPT_PLACEHOLDERS.map((key) => `{{${key}}}`).join("  ")}</Muted>
            {settings.saveError ? (
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
                {settings.saveError}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                theme={theme}
                label="Save template"
                disabled={
                  !values || templateDraft === null || templateDraft === values.promptTemplate
                }
                busy={settings.saving}
                onPress={() => {
                  if (settings.status !== "ready" || templateDraft === null || !templateRevision)
                    return;
                  void settings
                    .save({ ...settings.values, promptTemplate: templateDraft }, templateRevision)
                    .then((ok) => {
                      if (ok) {
                        toast.show("Template saved", { variant: "success" });
                        setTemplateDraft(null);
                      } else {
                        toast.error(
                          settings.saveError ??
                            "Another client changed the settings. Reload and try again.",
                        );
                      }
                    });
                }}
              />
              <Button
                theme={theme}
                variant="secondary"
                label="Reset to default"
                disabled={!values}
                onPress={() => setTemplateDraft(DEFAULT_PROMPT_TEMPLATE)}
              />
            </View>
          </View>
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

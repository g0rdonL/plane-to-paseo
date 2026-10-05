import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { Issue, IssueDetail, IssueImage, IssueState, User } from "../../shared/contracts";
import { assigneeNames, orderComments } from "../../shared/prompt";
import type { Preferences } from "../../shared/settings";
import { useClientLog, useCredentialsStatusQuery, useIssueDetailQuery } from "../queries";
import { StartForm } from "../start/start-form";
import {
  Button,
  Chip,
  Dot,
  displayName,
  ErrorText,
  estimateLabel,
  KeyValue,
  Muted,
  PRIORITY_COLORS,
  relativeTime,
  SectionTitle,
  Spinner,
  StateDot,
} from "../ui";
import { openExternal } from "../web";
import { AssigneeEditor } from "./assignee-editor";
import { MarkdownText } from "./markdown-text";
import { StatePicker } from "./state-picker";

export interface IssueModalProps {
  theme: PluginTheme;
  layout: { compact: boolean };
  issue: Issue;
  navigation?: PluginSurfaceProps["navigation"];
  fixedWorkspaceId?: string;
  preferences: Preferences;
  savePreferences?: (values: Partial<Preferences>) => Promise<boolean>;
  onClose(): void;
}

function ImageStrip({
  theme,
  images,
  compact,
}: {
  theme: PluginTheme;
  images: IssueImage[];
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState<IssueImage | null>(null);
  if (images.length === 0) return null;
  const size = compact ? 96 : 120;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {images.map((image) =>
          image.data ? (
            <Pressable
              key={image.url}
              accessibilityRole="imagebutton"
              accessibilityLabel={image.alt ?? "Work item image"}
              onPress={() => setExpanded(expanded?.url === image.url ? null : image)}
            >
              <Image
                source={{ uri: `data:${image.mimeType ?? "image/png"};base64,${image.data}` }}
                style={{
                  width: size,
                  height: size,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                }}
                resizeMode="cover"
              />
            </Pressable>
          ) : (
            <Pressable
              key={image.url}
              accessibilityRole="link"
              onPress={() => void openExternal(image.url).catch(() => {})}
              style={{
                width: size,
                height: size,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                alignItems: "center",
                justifyContent: "center",
                padding: 6,
                gap: 4,
              }}
            >
              <Icon name="ImageOff" size={18} color={theme.colors.foregroundMuted} />
              <Muted theme={theme} style={{ textAlign: "center", fontSize: 11 }}>
                {image.error ?? "unavailable"}
              </Muted>
            </Pressable>
          ),
        )}
      </View>
      {expanded?.data ? (
        <Pressable
          onPress={() => setExpanded(null)}
          accessibilityRole="button"
          accessibilityLabel="Collapse image"
        >
          <Image
            source={{ uri: `data:${expanded.mimeType ?? "image/png"};base64,${expanded.data}` }}
            style={{
              width: "100%",
              height: compact ? 260 : 420,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
            }}
            resizeMode="contain"
          />
          {expanded.alt ? (
            <Muted theme={theme} style={{ textAlign: "center", marginTop: 4 }}>
              {expanded.alt}
            </Muted>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

function Comments({ theme, detail }: { theme: PluginTheme; detail: IssueDetail }) {
  if (detail.comments.length === 0) return <Muted theme={theme}>No comments.</Muted>;
  return (
    <View style={{ gap: 10 }}>
      {orderComments(detail.comments).map((comment) => (
        <View
          key={comment.id}
          style={{
            padding: 10,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
              {displayName(comment.user)}
            </Text>
            <Muted theme={theme}>{relativeTime(comment.createdAt)}</Muted>
          </View>
          <MarkdownText theme={theme} markdown={comment.body} fontSize={13} />
        </View>
      ))}
    </View>
  );
}

export function IssueModal({
  theme,
  layout,
  issue,
  navigation,
  fixedWorkspaceId,
  preferences,
  savePreferences,
  onClose,
}: IssueModalProps) {
  const compact = layout.compact;
  const toast = useToast();
  const detailQuery = useIssueDetailQuery(issue);
  const detail = detailQuery.data ?? null;
  const [startOpen, setStartOpen] = useState(false);
  const viewerId = useCredentialsStatusQuery().data?.viewer?.id ?? null;
  // Local copy so an edit shows immediately; the list refetches in the background.
  const [assignees, setAssignees] = useState<User[]>(issue.assignees);
  const [editingAssignees, setEditingAssignees] = useState(false);
  const [state, setState] = useState<IssueState>(issue.state);
  const [statePickerOpen, setStatePickerOpen] = useState(false);
  const log = useClientLog();
  // The list polls, so `issue.assignees` is a new array on every refetch: sync on the ids, and
  // only leave edit mode when a different work item opens.
  const assigneeKey = issue.assignees.map((user) => user.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on ids, see above
  useEffect(() => {
    setAssignees(issue.assignees);
  }, [assigneeKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the work item changes
  useEffect(() => {
    setEditingAssignees(false);
    setStatePickerOpen(false);
  }, [issue.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the state id
  useEffect(() => {
    setState(issue.state);
  }, [issue.state.id]);
  const priorityColor = PRIORITY_COLORS(theme)[issue.priority] ?? theme.colors.foregroundMuted;

  return (
    <Modal title={issue.identifier} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content
        scrollable={false}
        style={{ backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{ padding: 0, gap: 0 }}
      >
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ padding: compact ? 14 : 20, gap: 8 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: compact ? 18 : 20,
              fontWeight: "700",
              lineHeight: 26,
            }}
          >
            {issue.title}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Status: ${state.name}. Change status`}
              onPress={() => setStatePickerOpen((open) => !open)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: theme.colors.border,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <StateDot theme={theme} state={state} />
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{state.name}</Text>
              <Icon
                name={statePickerOpen ? "ChevronUp" : "ChevronDown"}
                size={14}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
            <Text style={{ color: priorityColor, fontSize: 13, fontWeight: "600" }}>
              {issue.priorityLabel}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
              {issue.project.name}
            </Text>
            <Chip
              theme={theme}
              compact
              icon="ExternalLink"
              label="Open in Plane"
              onPress={() => void openExternal(issue.url).catch(() => {})}
            />
          </View>

          {statePickerOpen ? (
            <StatePicker
              theme={theme}
              compact={compact}
              issueId={issue.id}
              projectId={issue.project.id}
              current={state}
              onSaved={(next) => {
                setState(next);
                setStatePickerOpen(false);
                toast.show(`${issue.identifier} moved to ${next.name}`, {
                  variant: "success",
                  durationMs: 3000,
                });
              }}
            />
          ) : null}

          <View
            style={{
              flexDirection: compact ? "column" : "row",
              gap: compact ? 12 : 16,
              marginTop: 4,
            }}
          >
            <Button
              theme={theme}
              icon="Play"
              label={startOpen ? "Hide hand-off form" : "Start work in Paseo"}
              onPress={() => {
                log(
                  "info",
                  `${issue.identifier}: hand-off form ${startOpen ? "closed" : "opened"}`,
                );
                setStartOpen((open) => !open);
              }}
              disabled={!detail}
              style={{ flex: compact ? undefined : 1 }}
            />
          </View>

          {startOpen && detail ? (
            <StartForm
              theme={theme}
              compact={compact}
              detail={detail}
              navigation={navigation}
              fixedWorkspaceId={fixedWorkspaceId}
              preferences={preferences}
              savePreferences={savePreferences}
              onStarted={(summary) => {
                toast.show(summary, { variant: "success", durationMs: 4000 });
                onClose();
              }}
            />
          ) : null}

          <SectionTitle theme={theme}>Details</SectionTitle>
          <KeyValue
            theme={theme}
            label={assignees.length > 1 ? "Assignees" : "Assignee"}
            value={
              <View
                style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}
              >
                <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
                  {assignees.length ? assigneeNames({ assignees }) : "Unassigned"}
                </Text>
                {editingAssignees ? null : (
                  <Chip
                    theme={theme}
                    compact
                    icon="Pencil"
                    label="Edit"
                    onPress={() => setEditingAssignees(true)}
                  />
                )}
              </View>
            }
          />
          {editingAssignees ? (
            <AssigneeEditor
              theme={theme}
              compact={compact}
              issueId={issue.id}
              projectId={issue.project.id}
              current={assignees}
              viewerId={viewerId}
              onSaved={(next) => {
                setAssignees(next);
                setEditingAssignees(false);
                toast.show(
                  next.length
                    ? `${issue.identifier} assigned to ${assigneeNames({ assignees: next })}`
                    : `${issue.identifier} is now unassigned`,
                  { variant: "success", durationMs: 3000 },
                );
              }}
              onCancel={() => setEditingAssignees(false)}
            />
          ) : null}
          {detail?.cycle ? (
            <KeyValue theme={theme} label="Cycle" value={detail.cycle.name} />
          ) : null}
          {issue.estimate ? (
            <KeyValue theme={theme} label="Estimate" value={estimateLabel(issue.estimate)} />
          ) : null}
          {issue.dueDate ? <KeyValue theme={theme} label="Due" value={issue.dueDate} /> : null}
          {detail?.creator ? (
            <KeyValue
              theme={theme}
              label="Created by"
              value={`${displayName(detail.creator)} · ${relativeTime(issue.createdAt)}`}
            />
          ) : null}
          <KeyValue theme={theme} label="Updated" value={relativeTime(issue.updatedAt)} />
          <KeyValue theme={theme} label="Branch" value={issue.branchName} />
          {issue.labels.length ? (
            <KeyValue
              theme={theme}
              label="Labels"
              value={
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {issue.labels.map((label) => (
                    <View
                      key={label.id}
                      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                    >
                      <Dot color={label.color ?? theme.colors.foregroundMuted} size={7} />
                      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                        {label.name}
                      </Text>
                    </View>
                  ))}
                </View>
              }
            />
          ) : null}
          {detail?.parent ? (
            <KeyValue
              theme={theme}
              label="Parent"
              value={
                <Pressable
                  accessibilityRole="link"
                  onPress={() => void openExternal(detail.parent?.url ?? "").catch(() => {})}
                >
                  <Text style={{ color: theme.colors.accent, fontSize: 13 }}>
                    {detail.parent.identifier} {detail.parent.title}
                  </Text>
                </Pressable>
              }
            />
          ) : null}

          <SectionTitle theme={theme}>Description</SectionTitle>
          {detailQuery.isLoading ? (
            <Spinner theme={theme} />
          ) : detailQuery.error ? (
            <ErrorText theme={theme}>{(detailQuery.error as Error).message}</ErrorText>
          ) : detail?.description?.trim() ? (
            <MarkdownText theme={theme} markdown={detail.description} />
          ) : (
            <Muted theme={theme}>No description.</Muted>
          )}

          {detail && detail.images.length > 0 ? (
            <>
              <SectionTitle theme={theme}>
                {`Images (${detail.images.filter((image) => image.data).length}/${detail.images.length})`}
              </SectionTitle>
              <ImageStrip theme={theme} images={detail.images} compact={compact} />
            </>
          ) : null}

          {detail && detail.attachments.length > 0 ? (
            <>
              <SectionTitle theme={theme}>Links</SectionTitle>
              <View style={{ gap: 6 }}>
                {detail.attachments.map((attachment) => (
                  <Pressable
                    key={attachment.id}
                    accessibilityRole="link"
                    onPress={() => void openExternal(attachment.url).catch(() => {})}
                    style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                  >
                    <Icon name="Paperclip" size={14} color={theme.colors.foregroundMuted} />
                    <Text
                      numberOfLines={1}
                      style={{ color: theme.colors.accent, fontSize: 13, flex: 1 }}
                    >
                      {attachment.title?.trim() || attachment.url}
                    </Text>
                    {attachment.sourceType ? (
                      <Muted theme={theme}>{attachment.sourceType}</Muted>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          <SectionTitle theme={theme}>
            {detail ? `Comments (${detail.comments.length})` : "Comments"}
          </SectionTitle>
          {detail ? (
            <Comments theme={theme} detail={detail} />
          ) : detailQuery.isLoading ? null : (
            <Muted theme={theme}>—</Muted>
          )}
          <View style={{ height: 12 }} />
        </ScrollView>
      </Modal.Content>
    </Modal>
  );
}

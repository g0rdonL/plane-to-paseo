import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { User } from "../../shared/contracts";
import { useProjectMembersQuery, useSetAssigneesMutation } from "../queries";
import { Button, displayName, ErrorText, Muted, Spinner } from "../ui";

export interface AssigneeEditorProps {
  theme: PluginTheme;
  compact: boolean;
  issueId: string;
  projectId: string;
  current: User[];
  viewerId: string | null;
  onSaved(assignees: User[]): void;
  onCancel(): void;
}

/** Checklist of project members; saving replaces the work item's whole assignee list. */
export function AssigneeEditor({
  theme,
  compact,
  issueId,
  projectId,
  current,
  viewerId,
  onSaved,
  onCancel,
}: AssigneeEditorProps) {
  const membersQuery = useProjectMembersQuery(projectId, true);
  const mutation = useSetAssigneesMutation();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current.map((u) => u.id)));

  // Current assignees who have since left the project stay visible so they can be removed.
  const people = useMemo(() => {
    const members = membersQuery.data ?? [];
    const byId = new Map(members.map((user) => [user.id, user]));
    for (const user of current) if (!byId.has(user.id)) byId.set(user.id, user);
    return [...byId.values()].sort((a, b) => {
      if (a.id === viewerId) return -1;
      if (b.id === viewerId) return 1;
      return displayName(a).localeCompare(displayName(b));
    });
  }, [membersQuery.data, current, viewerId]);

  const unchanged =
    selected.size === current.length && current.every((user) => selected.has(user.id));

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    // Keep the people order stable in what we send: viewer first, then alphabetical.
    const assigneeIds = people.filter((user) => selected.has(user.id)).map((user) => user.id);
    const result = await mutation.mutateAsync({ issueId, projectId, assigneeIds });
    onSaved(result.assignees);
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        gap: 4,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {membersQuery.isPending ? (
        <View style={{ paddingVertical: 12 }}>
          <Spinner theme={theme} />
        </View>
      ) : membersQuery.error ? (
        <ErrorText theme={theme}>{(membersQuery.error as Error).message}</ErrorText>
      ) : people.length === 0 ? (
        <Muted theme={theme}>This project has no members to assign.</Muted>
      ) : (
        people.map((user) => {
          const checked = selected.has(user.id);
          const label = `${displayName(user)}${user.id === viewerId ? " (you)" : ""}`;
          return (
            <Pressable
              key={user.id}
              accessibilityRole="checkbox"
              accessibilityLabel={label}
              accessibilityState={{ checked, disabled: mutation.isPending }}
              disabled={mutation.isPending}
              onPress={() => toggle(user.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: compact ? 9 : 7,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Icon
                name={checked ? "SquareCheck" : "Square"}
                size={20}
                color={checked ? theme.colors.accent : theme.colors.foregroundMuted}
              />
              <Text style={{ color: theme.colors.foreground, fontSize: 14, flex: 1 }}>{label}</Text>
            </Pressable>
          );
        })
      )}

      {mutation.error ? (
        <ErrorText theme={theme}>{(mutation.error as Error).message}</ErrorText>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
        <Button
          theme={theme}
          label={selected.size === 0 && current.length > 0 ? "Unassign all" : "Save"}
          icon="Check"
          onPress={() => void save().catch(() => {})}
          busy={mutation.isPending}
          disabled={unchanged || membersQuery.isPending}
          style={{ flex: 1 }}
        />
        <Button
          theme={theme}
          label="Cancel"
          variant="secondary"
          onPress={onCancel}
          disabled={mutation.isPending}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

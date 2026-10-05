import type { PluginTheme } from "@getpaseo/plugin";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Issue } from "../../shared/contracts";
import {
  assigneesLabel,
  Dot,
  estimateLabel,
  IconButton,
  PriorityMark,
  relativeTime,
  StateDot,
} from "../ui";
import { openExternal } from "../web";

export interface IssueRowProps {
  theme: PluginTheme;
  compact: boolean;
  issue: Issue;
  onPress(issue: Issue): void;
}

export const IssueRow = memo(function IssueRow({ theme, compact, issue, onPress }: IssueRowProps) {
  const labels = issue.labels.slice(0, compact ? 2 : 4);
  const hiddenLabels = issue.labels.length - labels.length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${issue.identifier} ${issue.title}`}
      onPress={() => onPress(issue)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: compact ? 8 : 10,
        paddingHorizontal: compact ? 8 : 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface1 : theme.colors.surface0,
      })}
    >
      <View style={{ paddingTop: 3 }}>
        <PriorityMark theme={theme} priority={issue.priority} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <StateDot theme={theme} state={issue.state} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
            {issue.identifier}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {issue.state.name}
          </Text>
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.foreground,
            fontSize: compact ? 14 : 15,
            fontWeight: "500",
            lineHeight: 20,
          }}
        >
          {issue.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {assigneesLabel(issue)}
          </Text>
          {labels.map((label) => (
            <View key={label.id} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Dot color={label.color ?? theme.colors.foregroundMuted} size={6} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {label.name}
              </Text>
            </View>
          ))}
          {hiddenLabels > 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              +{hiddenLabels}
            </Text>
          ) : null}
          {issue.estimate ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {estimateLabel(issue.estimate)}
            </Text>
          ) : null}
          {issue.dueDate ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              due {issue.dueDate}
            </Text>
          ) : null}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginLeft: "auto" }}>
            {relativeTime(issue.updatedAt)}
          </Text>
        </View>
      </View>
      <IconButton
        theme={theme}
        icon="ExternalLink"
        accessibilityLabel={`Open ${issue.identifier} in Plane`}
        onPress={() => void openExternal(issue.url).catch(() => {})}
      />
    </Pressable>
  );
});

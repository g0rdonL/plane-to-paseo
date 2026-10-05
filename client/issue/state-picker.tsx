import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { IssueState } from "../../shared/contracts";
import { STATE_TYPE_LABELS } from "../../shared/issue-query";
import { useProjectStatesQuery, useSetStateMutation } from "../queries";
import { ErrorText, Muted, Spinner, StateDot } from "../ui";

export interface StatePickerProps {
  theme: PluginTheme;
  compact: boolean;
  issueId: string;
  projectId: string;
  current: IssueState;
  onSaved(state: IssueState): void;
}

/** The project's workflow states, grouped; tapping one moves the work item immediately. */
export function StatePicker({
  theme,
  compact,
  issueId,
  projectId,
  current,
  onSaved,
}: StatePickerProps) {
  const statesQuery = useProjectStatesQuery(projectId, true);
  const mutation = useSetStateMutation();
  const pendingId = mutation.isPending ? mutation.variables?.stateId : null;

  async function choose(state: IssueState) {
    if (state.id === current.id || mutation.isPending) return;
    const result = await mutation.mutateAsync({ issueId, projectId, stateId: state.id });
    onSaved(result.state);
  }

  const states = statesQuery.data ?? [];
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        gap: 2,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {statesQuery.isPending ? (
        <View style={{ paddingVertical: 12 }}>
          <Spinner theme={theme} />
        </View>
      ) : statesQuery.error ? (
        <ErrorText theme={theme}>{(statesQuery.error as Error).message}</ErrorText>
      ) : states.length === 0 ? (
        <Muted theme={theme}>This project has no workflow states.</Muted>
      ) : (
        states.map((state, index) => {
          const selected = state.id === current.id;
          const newGroup = index === 0 || states[index - 1]?.type !== state.type;
          return (
            <View key={state.id}>
              {newGroup ? (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontWeight: "600",
                    textTransform: "uppercase",
                    marginTop: index === 0 ? 0 : 8,
                    marginBottom: 2,
                  }}
                >
                  {STATE_TYPE_LABELS[state.type] ?? state.type}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={`Move to ${state.name}`}
                accessibilityState={{ checked: selected, disabled: mutation.isPending }}
                disabled={mutation.isPending}
                onPress={() => void choose(state).catch(() => {})}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingVertical: compact ? 9 : 7,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <StateDot theme={theme} state={state} />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 14,
                    flex: 1,
                    fontWeight: selected ? "600" : "400",
                  }}
                >
                  {state.name}
                </Text>
                {pendingId === state.id ? (
                  <Spinner theme={theme} />
                ) : selected ? (
                  <Icon name="Check" size={16} color={theme.colors.accent} />
                ) : null}
              </Pressable>
            </View>
          );
        })
      )}
      {mutation.error ? (
        <ErrorText theme={theme}>{(mutation.error as Error).message}</ErrorText>
      ) : null}
    </View>
  );
}

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type MySprint, type SprintPerson, STATE_TYPES } from "../../shared/contracts";
import {
  ASSIGNEE_FILTER_LABELS,
  type AssigneeFilter,
  DUE_FILTER_LABELS,
  DUE_FILTERS,
  type DueFilter,
  type IssueFacets,
  type IssueFilters,
  NO_ESTIMATE,
  PRIORITY_LABELS,
  SORT_KEYS,
  SORT_LABELS,
  type SortKey,
  STATE_TYPE_LABELS,
} from "../../shared/issue-query";
import { Button, Chip, Dot, displayName, PRIORITY_COLORS } from "../ui";

export interface FilterBarProps {
  theme: PluginTheme;
  compact: boolean;
  filters: IssueFilters;
  facets: IssueFacets;
  sort: SortKey;
  viewerId: string | null;
  /** The viewer's sprints, oldest first; none hides the sprint chip. */
  sprints?: MySprint[];
  /** Whose sprint can be opened, viewer first; fewer than two hides the person chip. */
  sprintPeople?: SprintPerson[];
  onFiltersChange(next: IssueFilters): void;
  onSortChange(next: SortKey): void;
  onModalOpenChange?(open: boolean): void;
}

type Picker =
  | "project"
  | "state"
  | "assignee"
  | "priority"
  | "label"
  | "due"
  | "estimate"
  | "sprint"
  | "sprintPerson"
  | "sort"
  | null;

interface Option {
  id: string;
  label: string;
  count?: number;
  color?: string | null;
  selected: boolean;
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

const estimateName = (value: string) => (value === NO_ESTIMATE ? "No estimate" : `${value} pt`);

/** "Sprint 2026-W42" -> "W42"; anything else is shown as is. */
const sprintShortName = (label: string) => label.match(/W\d+$/)?.[0] ?? label;

const formatPoints = (value: number) => (Number.isInteger(value) ? `${value}` : value.toFixed(1));

function summarize(labels: string[], fallback: string): string {
  if (labels.length === 0) return fallback;
  if (labels.length === 1) return labels[0] as string;
  return `${labels[0]} +${labels.length - 1}`;
}

export function FilterBar({
  theme,
  compact,
  filters,
  facets,
  sort,
  viewerId,
  sprints = [],
  sprintPeople = [],
  onFiltersChange,
  onSortChange,
  onModalOpenChange,
}: FilterBarProps) {
  const [picker, setPickerState] = useState<Picker>(null);
  const setPicker = (next: Picker) => {
    setPickerState(next);
    onModalOpenChange?.(next !== null);
  };
  const update = (patch: Partial<IssueFilters>) => onFiltersChange({ ...filters, ...patch });

  const projectLabel = summarize(
    facets.projects.filter((f) => filters.projectIds.includes(f.value.id)).map((f) => f.value.key),
    "Project",
  );
  const pickedSprint = sprints.find((sprint) => sprint.startDate === filters.sprint);
  const sprintLabel = pickedSprint ? sprintShortName(pickedSprint.label) : "Sprint";
  // Red over capacity, green exactly full, plain otherwise (as on the web).
  const pointsStyle = (used: number, capacity: number) =>
    used > capacity
      ? { color: theme.colors.statusDanger }
      : used === capacity && capacity > 0
        ? { color: theme.colors.statusSuccess }
        : undefined;
  const sprintPerson = sprintPeople.find((person) => person.id === filters.sprintUserId);
  const sprintPersonLabel = sprintPerson ? (sprintPerson.name.split(" ")[0] as string) : "Me";
  const stateLabel = summarize(
    [
      ...filters.stateTypes.map((type) => STATE_TYPE_LABELS[type] ?? type),
      ...facets.states.filter((s) => filters.stateIds.includes(s.id)).map((s) => s.name),
    ],
    "Status",
  );
  const assigneeLabel =
    filters.assignee !== "any"
      ? ASSIGNEE_FILTER_LABELS[filters.assignee]
      : summarize(
          facets.assignees
            .filter((f) => filters.assigneeIds.includes(f.value.id))
            .map((f) => displayName(f.value)),
          "Assignee",
        );
  const priorityLabel = summarize(
    [...filters.priorities].sort().map((p) => PRIORITY_LABELS[p] ?? String(p)),
    "Priority",
  );
  const labelLabel = summarize(
    facets.labels.filter((f) => filters.labelIds.includes(f.value.id)).map((f) => f.value.name),
    "Label",
  );

  const estimateLabel = summarize(filters.estimates.map(estimateName), "Estimate");
  const hasEstimates = facets.estimates.some((f) => f.value !== NO_ESTIMATE);

  const priorityColors = PRIORITY_COLORS(theme);

  const pickerOptions = (): {
    title: string;
    options: Option[];
    onToggle(id: string): void;
    onClear(): void;
    single?: boolean;
  } | null => {
    switch (picker) {
      case "project":
        return {
          title: "Filter by project",
          options: facets.projects.map((f) => ({
            id: f.value.id,
            label: `${f.value.key} · ${f.value.name}`,
            count: f.count,
            selected: filters.projectIds.includes(f.value.id),
          })),
          onToggle: (id) => update({ projectIds: toggle(filters.projectIds, id) }),
          onClear: () => update({ projectIds: [] }),
        };
      case "state": {
        const typeOptions: Option[] = STATE_TYPES.filter(
          (type) => facets.states.some((s) => s.type === type) || filters.stateTypes.includes(type),
        ).map((type) => ({
          id: `type:${type}`,
          label: `All ${STATE_TYPE_LABELS[type] ?? type}`,
          count: facets.states.filter((s) => s.type === type).reduce((sum, s) => sum + s.count, 0),
          selected: filters.stateTypes.includes(type),
        }));
        const stateOptions: Option[] = facets.states.map((s) => ({
          id: `id:${s.id}`,
          label: s.name,
          count: s.count,
          color: s.color,
          selected: filters.stateIds.includes(s.id),
        }));
        return {
          title: "Filter by status",
          options: [...typeOptions, ...stateOptions],
          onToggle: (id) => {
            if (id.startsWith("type:"))
              update({ stateTypes: toggle(filters.stateTypes, id.slice(5)) });
            else update({ stateIds: toggle(filters.stateIds, id.slice(3)) });
          },
          onClear: () => update({ stateTypes: [], stateIds: [] }),
        };
      }
      case "assignee": {
        const modes: Array<{ id: AssigneeFilter; label: string }> = [
          { id: "me-or-unassigned", label: ASSIGNEE_FILTER_LABELS["me-or-unassigned"] },
          { id: "me", label: ASSIGNEE_FILTER_LABELS.me },
          { id: "unassigned", label: ASSIGNEE_FILTER_LABELS.unassigned },
        ];
        return {
          title: "Filter by assignee",
          options: [
            ...modes
              .filter((mode) => mode.id === "unassigned" || viewerId)
              .map((mode) => ({
                id: `mode:${mode.id}`,
                label: mode.label,
                selected: filters.assignee === mode.id,
              })),
            ...facets.assignees.map((f) => ({
              id: `user:${f.value.id}`,
              label: displayName(f.value),
              count: f.count,
              selected: filters.assignee === "any" && filters.assigneeIds.includes(f.value.id),
            })),
          ],
          onToggle: (id) => {
            if (id.startsWith("mode:")) {
              const mode = id.slice(5) as AssigneeFilter;
              update({ assignee: filters.assignee === mode ? "any" : mode, assigneeIds: [] });
            } else {
              update({ assignee: "any", assigneeIds: toggle(filters.assigneeIds, id.slice(5)) });
            }
          },
          onClear: () => update({ assignee: "any", assigneeIds: [] }),
        };
      }
      case "priority":
        return {
          title: "Filter by priority",
          options: [1, 2, 3, 4, 0].map((p) => ({
            id: String(p),
            label: PRIORITY_LABELS[p] ?? String(p),
            count: facets.priorities.find((f) => f.value === p)?.count ?? 0,
            color: priorityColors[p],
            selected: filters.priorities.includes(p),
          })),
          onToggle: (id) => {
            const p = Number(id);
            update({
              priorities: filters.priorities.includes(p)
                ? filters.priorities.filter((x) => x !== p)
                : [...filters.priorities, p],
            });
          },
          onClear: () => update({ priorities: [] }),
        };
      case "label":
        return {
          title: "Filter by label",
          options: facets.labels.map((f) => ({
            id: f.value.id,
            label: f.value.name,
            count: f.count,
            color: f.value.color,
            selected: filters.labelIds.includes(f.value.id),
          })),
          onToggle: (id) => update({ labelIds: toggle(filters.labelIds, id) }),
          onClear: () => update({ labelIds: [] }),
        };
      case "due":
        return {
          title: "Filter by due date",
          single: true,
          options: DUE_FILTERS.filter((key) => key !== "any").map((key) => ({
            id: key,
            label: DUE_FILTER_LABELS[key],
            selected: filters.due === key,
          })),
          onToggle: (id) => {
            update({ due: filters.due === id ? "any" : (id as DueFilter) });
            setPicker(null);
          },
          onClear: () => update({ due: "any" }),
        };
      case "estimate":
        return {
          title: "Filter by estimate",
          options: facets.estimates.map((f) => ({
            id: f.value,
            label: estimateName(f.value),
            count: f.count,
            selected: filters.estimates.includes(f.value),
          })),
          onToggle: (id) => update({ estimates: toggle(filters.estimates, id) }),
          onClear: () => update({ estimates: [] }),
        };
      case "sprint":
        return {
          title: "Filter by sprint",
          single: true,
          options: sprints.map((sprint) => ({
            id: sprint.startDate,
            label: `${sprintShortName(sprint.label)} · ${sprint.startDate} – ${sprint.endDate}${
              sprint.isCurrent ? " (this week)" : ""
            }`,
            count: sprint.issueIds.length,
            selected: filters.sprint === sprint.startDate,
          })),
          onToggle: (id) => {
            update({ sprint: filters.sprint === id ? null : id });
            setPicker(null);
          },
          onClear: () => update({ sprint: null }),
        };
      case "sprintPerson":
        return {
          title: "Sprint of",
          single: true,
          options: sprintPeople.map((person) => ({
            id: person.id,
            label: person.isMe ? `${person.name} (me)` : person.name,
            selected: person.isMe
              ? filters.sprintUserId === null
              : filters.sprintUserId === person.id,
          })),
          onToggle: (id) => {
            const person = sprintPeople.find((p) => p.id === id);
            // Another person's stories are not assigned to the viewer, so the default
            // "mine or unassigned" assignee filter would hide all of them.
            update({
              sprintUserId: !person || person.isMe ? null : id,
              ...(person && !person.isMe ? { assignee: "any", assigneeIds: [] } : {}),
            });
            setPicker(null);
          },
          onClear: () => update({ sprintUserId: null }),
        };
      case "sort":
        return {
          title: "Sort by",
          single: true,
          options: SORT_KEYS.map((key) => ({
            id: key,
            label: SORT_LABELS[key],
            selected: key === sort,
          })),
          onToggle: (id) => {
            onSortChange(id as SortKey);
            setPicker(null);
          },
          onClear: () => onSortChange("priority"),
        };
      default:
        return null;
    }
  };

  const current = pickerOptions();

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ paddingVertical: 6 }}
        contentContainerStyle={{
          flexDirection: "row",
          gap: 6,
          paddingHorizontal: compact ? 8 : 12,
          alignItems: "center",
        }}
      >
        <Chip
          theme={theme}
          compact
          icon="ArrowUpDown"
          label={SORT_LABELS[sort]}
          onPress={() => setPicker("sort")}
          accessibilityLabel={`Sort by ${SORT_LABELS[sort]}`}
        />
        <View style={{ width: 1, height: 18, backgroundColor: theme.colors.border }} />
        {sprints.length || filters.sprint ? (
          <Chip
            theme={theme}
            compact
            icon="CalendarClock"
            label={sprintLabel}
            selected={filters.sprint !== null}
            trailingIcon="ChevronDown"
            onPress={() => setPicker("sprint")}
          />
        ) : null}
        {sprintPeople.length > 1 ? (
          <Chip
            theme={theme}
            compact
            icon="User"
            label={sprintPersonLabel}
            selected={filters.sprintUserId !== null}
            trailingIcon="ChevronDown"
            onPress={() => setPicker("sprintPerson")}
          />
        ) : null}
        <Chip
          theme={theme}
          compact
          label={stateLabel}
          selected={filters.stateIds.length > 0 || filters.stateTypes.length > 0}
          trailingIcon="ChevronDown"
          onPress={() => setPicker("state")}
        />
        <Chip
          theme={theme}
          compact
          label={assigneeLabel}
          selected={filters.assignee !== "any" || filters.assigneeIds.length > 0}
          trailingIcon="ChevronDown"
          onPress={() => setPicker("assignee")}
        />
        <Chip
          theme={theme}
          compact
          label={priorityLabel}
          selected={filters.priorities.length > 0}
          trailingIcon="ChevronDown"
          onPress={() => setPicker("priority")}
        />
        {facets.labels.length > 0 || filters.labelIds.length > 0 ? (
          <Chip
            theme={theme}
            compact
            label={labelLabel}
            selected={filters.labelIds.length > 0}
            trailingIcon="ChevronDown"
            onPress={() => setPicker("label")}
          />
        ) : null}
        <Chip
          theme={theme}
          compact
          label={projectLabel}
          selected={filters.projectIds.length > 0}
          trailingIcon="ChevronDown"
          onPress={() => setPicker("project")}
        />
        <Chip
          theme={theme}
          compact
          icon="CalendarDays"
          label={filters.due === "any" ? DUE_FILTER_LABELS.any : DUE_FILTER_LABELS[filters.due]}
          selected={filters.due !== "any"}
          trailingIcon="ChevronDown"
          onPress={() => setPicker("due")}
        />
        {hasEstimates || filters.estimates.length > 0 ? (
          <Chip
            theme={theme}
            compact
            label={estimateLabel}
            selected={filters.estimates.length > 0}
            trailingIcon="ChevronDown"
            onPress={() => setPicker("estimate")}
          />
        ) : null}
        {viewerId || filters.createdByMe ? (
          <Chip
            theme={theme}
            compact
            icon="PencilLine"
            label="Created by me"
            selected={filters.createdByMe}
            onPress={() => update({ createdByMe: !filters.createdByMe })}
          />
        ) : null}
        <Chip
          theme={theme}
          compact
          label="Closed"
          icon={filters.includeClosed ? "Eye" : "EyeOff"}
          selected={filters.includeClosed}
          onPress={() => update({ includeClosed: !filters.includeClosed })}
          accessibilityLabel={
            filters.includeClosed ? "Hide closed work items" : "Show closed work items"
          }
        />
      </ScrollView>

      {pickedSprint ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            paddingHorizontal: compact ? 8 : 12,
            paddingBottom: 6,
          }}
        >
          <Text style={pointsStyle(pickedSprint.plannedPoints, pickedSprint.capacity)}>
            {formatPoints(pickedSprint.plannedPoints)}/{formatPoints(pickedSprint.capacity)} pts
          </Text>
          {" + "}
          <Text style={pointsStyle(pickedSprint.bufferPoints, pickedSprint.bufferCapacity)}>
            {formatPoints(pickedSprint.bufferPoints)}/{formatPoints(pickedSprint.bufferCapacity)}{" "}
            buffer
          </Text>
          {` · ${formatPoints(pickedSprint.donePoints)} done`}
          {pickedSprint.unestimated > 0 ? ` · ${pickedSprint.unestimated} unestimated` : ""}
        </Text>
      ) : null}

      <Modal
        title={current?.title ?? ""}
        open={current !== null}
        onOpenChange={(open) => (open ? null : setPicker(null))}
      >
        <Modal.Content
          scrollable={false}
          style={{ backgroundColor: theme.colors.surface0 }}
          contentContainerStyle={{ padding: 0, gap: 0 }}
        >
          {current ? (
            <View style={{ flex: 1, minHeight: 0 }}>
              <ScrollView style={{ flex: 1, minHeight: 0 }}>
                {current.options.length === 0 ? (
                  <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>
                    Nothing to filter by yet.
                  </Text>
                ) : null}
                {current.options.map((option) => (
                  <Pressable
                    key={option.id}
                    accessibilityRole={current.single ? "radio" : "checkbox"}
                    accessibilityState={{ checked: option.selected }}
                    onPress={() => current.onToggle(option.id)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                      borderBottomWidth: 1,
                      borderBottomColor: theme.colors.border,
                      backgroundColor: pressed ? theme.colors.surface1 : "transparent",
                    })}
                  >
                    <Icon
                      name={
                        current.single
                          ? option.selected
                            ? "CircleDot"
                            : "Circle"
                          : option.selected
                            ? "SquareCheck"
                            : "Square"
                      }
                      size={18}
                      color={option.selected ? theme.colors.accent : theme.colors.foregroundMuted}
                    />
                    {option.color ? <Dot color={option.color} /> : null}
                    <Text style={{ color: theme.colors.foreground, fontSize: 14, flex: 1 }}>
                      {option.label}
                    </Text>
                    {option.count !== undefined ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                        {option.count}
                      </Text>
                    ) : null}
                  </Pressable>
                ))}
              </ScrollView>
              <View
                style={{
                  flexDirection: "row",
                  gap: 8,
                  padding: 12,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.border,
                }}
              >
                <Button
                  theme={theme}
                  variant="secondary"
                  label={current.single ? "Reset" : "Clear"}
                  onPress={current.onClear}
                  style={{ flex: 1 }}
                />
                <Button
                  theme={theme}
                  label="Done"
                  onPress={() => setPicker(null)}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

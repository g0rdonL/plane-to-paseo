import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  type Issue,
  isAuthError,
  isNotConfiguredError,
  type MySprint,
  type SprintPerson,
} from "../../shared/contracts";
import {
  countActiveFilters,
  deriveFacets,
  EMPTY_FILTERS,
  type IssueFilters,
  queryIssues,
  type SortKey,
} from "../../shared/issue-query";
import { DEFAULT_PREFERENCES, preferences } from "../../shared/settings";
import { IssueModal } from "../issue/issue-modal";
import {
  useAppActive,
  useIssuesQuery,
  useMySprintQuery,
  useRefreshIssues,
  useRemoteSearchQuery,
  useSprintPeopleQuery,
} from "../queries";
import { Button, Centered, ErrorText, IconButton, Muted, Spinner } from "../ui";
import { FilterBar } from "./filter-bar";
import { IssueRow } from "./issue-row";

export interface IssueBrowserProps {
  theme: PluginTheme;
  layout: { compact: boolean };
  navigation?: PluginSurfaceProps["navigation"];
  /** Set inside a workspace panel: hand-offs default to this workspace. */
  fixedWorkspaceId?: string;
  openSettings?: () => void;
}

interface BrowserState {
  filters: IssueFilters;
  search: string;
  sort: SortKey;
  seededFromPreferences: boolean;
}

// Survives unmounts (switching sidebar screens) within one app session.
let rememberedState: BrowserState | null = null;

const EMPTY_SPRINTS: MySprint[] = [];
const EMPTY_PEOPLE: SprintPerson[] = [];

export function IssueBrowser({
  theme,
  layout,
  navigation,
  fixedWorkspaceId,
  openSettings,
}: IssueBrowserProps) {
  const compact = layout.compact;
  const toast = useToast();
  const settings = useSettings(preferences);
  const prefs = settings.status === "ready" ? settings.values : DEFAULT_PREFERENCES;

  const [state, setState] = useState<BrowserState>(
    () =>
      rememberedState ?? {
        filters: { ...EMPTY_FILTERS, assignee: DEFAULT_PREFERENCES.defaultAssignee },
        search: "",
        sort: DEFAULT_PREFERENCES.defaultSort,
        seededFromPreferences: false,
      },
  );
  useEffect(() => {
    rememberedState = state;
  }, [state]);

  // Seed sort, assignee scope and closed-visibility from the host preferences exactly once.
  useEffect(() => {
    if (settings.status !== "ready" || state.seededFromPreferences) return;
    setState((prev) => ({
      ...prev,
      sort: settings.values.defaultSort,
      filters: {
        ...prev.filters,
        assignee: settings.values.defaultAssignee,
        includeClosed: settings.values.includeClosed,
      },
      seededFromPreferences: true,
    }));
  }, [settings, state.seededFromPreferences]);

  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [remoteTerm, setRemoteTerm] = useState<string | null>(null);
  const appActive = useAppActive();

  const issuesQuery = useIssuesQuery({
    includeClosed: state.filters.includeClosed,
    poll: appActive && selectedIssue === null && !pickerOpen,
  });
  const refresh = useRefreshIssues(state.filters.includeClosed);
  const remote = useRemoteSearchQuery(remoteTerm ?? "", remoteTerm !== null);

  const issues = issuesQuery.data?.issues ?? [];
  const viewerId = issuesQuery.data?.viewer?.id ?? null;
  const sprintQuery = useMySprintQuery(Boolean(issuesQuery.data), state.filters.sprintUserId);
  const sprintPeopleQuery = useSprintPeopleQuery(Boolean(issuesQuery.data));
  const sprints = sprintQuery.data ?? EMPTY_SPRINTS;
  const sprintIds = useMemo(() => {
    const picked = sprints.find((sprint) => sprint.startDate === state.filters.sprint);
    return picked ? new Set(picked.issueIds) : null;
  }, [sprints, state.filters.sprint]);
  const facets = useMemo(() => deriveFacets(issues), [issues]);
  const visible = useMemo(
    () =>
      queryIssues(
        issues,
        {
          filters: state.filters,
          search: state.search,
          sort: state.sort,
          mineFirst: prefs.mineFirst,
          sprintIds,
        },
        viewerId,
      ),
    [issues, state.filters, state.search, state.sort, prefs.mineFirst, viewerId, sprintIds],
  );

  // Remote results that are not already in the local list.
  const remoteExtra = useMemo(() => {
    if (!remote.data || remoteTerm !== state.search.trim()) return [];
    const local = new Set(issues.map((issue) => issue.id));
    return remote.data.issues.filter((issue) => !local.has(issue.id));
  }, [remote.data, remoteTerm, state.search, issues]);

  const searchRef = useRef<TextInput>(null);
  const setSearch = useCallback((search: string) => {
    setState((prev) => ({ ...prev, search }));
    setRemoteTerm(null);
  }, []);

  const onRefresh = useCallback(() => {
    refresh.mutate(undefined, {
      onError: (error) => toast.error(`Refresh failed: ${(error as Error).message}`),
    });
  }, [refresh, toast]);

  const activeFilterCount = countActiveFilters(state.filters);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: compact ? 8 : 12,
        paddingTop: compact ? 8 : 12,
        paddingBottom: 4,
      },
      searchBox: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        height: 36,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      searchInput: { flex: 1, color: theme.colors.foreground, fontSize: 14, paddingVertical: 0 },
      meta: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 4,
      },
    }),
    [theme, compact],
  );

  const error = issuesQuery.error as Error | null;

  if (error && isNotConfiguredError(error)) {
    return (
      <Centered theme={theme}>
        <Icon name="KeyRound" size={28} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>
          Connect Plane
        </Text>
        <Muted theme={theme} style={{ textAlign: "center", maxWidth: 360 }}>
          Add a personal access token so this device can list your work items. The token is stored
          on the Paseo daemon only.
        </Muted>
        {openSettings ? (
          <Button
            theme={theme}
            label="Open Plane settings"
            icon="Settings"
            onPress={openSettings}
          />
        ) : (
          <Muted theme={theme}>Settings → Plugins → plane-to-paseo → Plane</Muted>
        )}
      </Centered>
    );
  }

  if (error && !issuesQuery.data) {
    return (
      <Centered theme={theme}>
        <ErrorText theme={theme}>{error.message}</ErrorText>
        {isAuthError(error) && openSettings ? (
          <Button
            theme={theme}
            variant="secondary"
            label="Check the API key"
            icon="KeyRound"
            onPress={openSettings}
          />
        ) : null}
        <Button
          theme={theme}
          label="Retry"
          icon="RefreshCw"
          onPress={onRefresh}
          busy={refresh.isPending}
        />
      </Centered>
    );
  }

  const listData: Array<{ kind: "issue"; issue: Issue } | { kind: "remote-header" }> = [
    ...visible.map((issue) => ({ kind: "issue" as const, issue })),
    ...(remoteExtra.length > 0
      ? [
          { kind: "remote-header" as const },
          ...remoteExtra.map((issue) => ({ kind: "issue" as const, issue })),
        ]
      : []),
  ];

  const canSearchRemote = state.search.trim().length >= 2 && remoteTerm !== state.search.trim();
  const loadingInitial = issuesQuery.isLoading && !issuesQuery.data;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.searchBox} onPress={() => searchRef.current?.focus()}>
          <Icon name="Search" size={15} color={theme.colors.foregroundMuted} />
          <TextInput
            ref={searchRef}
            value={state.search}
            onChangeText={setSearch}
            placeholder="Search work items"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={() => {
              if (canSearchRemote) setRemoteTerm(state.search.trim());
            }}
            accessibilityLabel="Search work items"
          />
          {state.search ? (
            <IconButton
              theme={theme}
              icon="X"
              accessibilityLabel="Clear search"
              onPress={() => setSearch("")}
            />
          ) : null}
        </Pressable>
        <IconButton
          theme={theme}
          icon="RefreshCw"
          accessibilityLabel="Refresh work items"
          onPress={onRefresh}
          busy={refresh.isPending || (issuesQuery.isFetching && !loadingInitial)}
        />
        {openSettings ? (
          <IconButton
            theme={theme}
            icon="Settings"
            accessibilityLabel="Plane settings"
            onPress={openSettings}
          />
        ) : null}
      </View>

      <FilterBar
        theme={theme}
        compact={compact}
        filters={state.filters}
        facets={facets}
        sort={state.sort}
        viewerId={viewerId}
        sprints={sprints}
        sprintPeople={sprintPeopleQuery.data ?? EMPTY_PEOPLE}
        onFiltersChange={(filters) => setState((prev) => ({ ...prev, filters }))}
        onSortChange={(sort) => setState((prev) => ({ ...prev, sort }))}
        onModalOpenChange={setPickerOpen}
      />

      <View style={styles.meta}>
        <Muted theme={theme}>
          {loadingInitial
            ? "Loading work items…"
            : `${visible.length} of ${issues.length} issue${issues.length === 1 ? "" : "s"}${
                issuesQuery.data?.truncated ? " (showing the 500 most recently updated)" : ""
              }`}
        </Muted>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {activeFilterCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                setState((prev) => ({
                  ...prev,
                  filters: { ...EMPTY_FILTERS, includeClosed: prev.filters.includeClosed },
                }))
              }
            >
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                Clear {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"}
              </Text>
            </Pressable>
          ) : null}
          {issuesQuery.data ? (
            <Muted theme={theme}>
              updated {new Date(issuesQuery.data.fetchedAt).toLocaleTimeString()}
            </Muted>
          ) : null}
        </View>
      </View>

      {loadingInitial ? (
        <Centered theme={theme}>
          <Spinner theme={theme} />
        </Centered>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={listData}
          keyExtractor={(item) => (item.kind === "issue" ? item.issue.id : "remote-header")}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) =>
            item.kind === "issue" ? (
              <IssueRow
                theme={theme}
                compact={compact}
                issue={item.issue}
                onPress={setSelectedIssue}
              />
            ) : (
              <View
                style={{ paddingHorizontal: compact ? 12 : 16, paddingTop: 12, paddingBottom: 4 }}
              >
                <Muted
                  theme={theme}
                  style={{ fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 }}
                >
                  More from Plane
                </Muted>
              </View>
            )
          }
          ListEmptyComponent={
            <View style={{ padding: 24, alignItems: "center", gap: 10 }}>
              <Muted theme={theme} style={{ textAlign: "center", fontSize: 13 }}>
                {issues.length === 0
                  ? state.filters.includeClosed
                    ? "No work items are visible to this token."
                    : "No open work items. Toggle “Closed” to include finished work."
                  : state.search
                    ? `Nothing loaded matches “${state.search}”.`
                    : "No work items match the current filters."}
              </Muted>
              {activeFilterCount > 0 ? (
                <Button
                  theme={theme}
                  variant="secondary"
                  label="Clear filters"
                  onPress={() =>
                    setState((prev) => ({
                      ...prev,
                      filters: { ...EMPTY_FILTERS, includeClosed: prev.filters.includeClosed },
                    }))
                  }
                />
              ) : null}
            </View>
          }
          ListFooterComponent={
            state.search.trim().length >= 2 ? (
              <View style={{ padding: 16, alignItems: "center", gap: 6 }}>
                {remote.isFetching ? (
                  <Spinner theme={theme} />
                ) : remoteTerm === state.search.trim() ? (
                  <Muted theme={theme}>
                    {remote.error
                      ? `Plane search failed: ${(remote.error as Error).message}`
                      : remoteExtra.length === 0
                        ? "Plane found nothing else."
                        : null}
                  </Muted>
                ) : (
                  <Button
                    theme={theme}
                    variant="secondary"
                    icon="Search"
                    label="Search all of Plane"
                    onPress={() => setRemoteTerm(state.search.trim())}
                  />
                )}
              </View>
            ) : null
          }
        />
      )}

      {selectedIssue ? (
        <IssueModal
          theme={theme}
          layout={layout}
          issue={selectedIssue}
          navigation={navigation}
          fixedWorkspaceId={fixedWorkspaceId}
          preferences={prefs}
          savePreferences={
            settings.status === "ready"
              ? (values) => settings.save({ ...settings.values, ...values }, settings.revision)
              : undefined
          }
          onClose={() => setSelectedIssue(null)}
        />
      ) : null}
    </View>
  );
}

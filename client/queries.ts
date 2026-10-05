import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  clientLog,
  credentialsClear,
  credentialsSet,
  credentialsStatus,
  type Issue,
  isAuthError,
  isNotConfiguredError,
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

export const queryKeys = {
  status: ["plane", "credentials"] as const,
  issues: (includeClosed: boolean) => ["plane", "issues", includeClosed] as const,
  detail: (issueId: string) => ["plane", "issue", issueId] as const,
  search: (term: string) => ["plane", "search", term] as const,
  members: (projectId: string) => ["plane", "members", projectId] as const,
  states: (projectId: string) => ["plane", "states", projectId] as const,
  sprint: (userId: string | null) => ["plane", "sprint", userId] as const,
  sprintPeople: ["plane", "sprint-people"] as const,
};

/** Never hammer Plane when the token is missing or rejected. */
function retryUnlessConfigError(failureCount: number, error: unknown): boolean {
  if (isNotConfiguredError(error) || isAuthError(error)) return false;
  return failureCount < 2;
}

export function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setActive(next === "active"),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

export function useCredentialsStatusQuery() {
  const status = useRpc(credentialsStatus);
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => status({}),
    staleTime: 60_000,
    retry: retryUnlessConfigError,
  });
}

export function useIssuesQuery(input: { includeClosed: boolean; poll: boolean }) {
  const list = useRpc(issuesList);
  return useQuery({
    queryKey: queryKeys.issues(input.includeClosed),
    queryFn: () => list({ includeClosed: input.includeClosed }),
    staleTime: 30_000,
    refetchInterval: input.poll ? 60_000 : false,
    refetchOnWindowFocus: true,
    retry: retryUnlessConfigError,
  });
}

/** Forces a daemon-side refetch (bypasses the 15 s server cache) and updates the query cache. */
export function useRefreshIssues(includeClosed: boolean) {
  const list = useRpc(issuesList);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => list({ includeClosed, refresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.issues(includeClosed), data);
    },
  });
}

export function useRemoteSearchQuery(term: string, enabled: boolean) {
  const search = useRpc(issuesSearch);
  return useQuery({
    queryKey: queryKeys.search(term),
    queryFn: () => search({ term }),
    enabled: enabled && term.trim().length > 0,
    staleTime: 60_000,
    retry: retryUnlessConfigError,
  });
}

export function useIssueDetailQuery(issue: Pick<Issue, "id" | "project"> | null) {
  const detail = useRpc(issueDetail);
  return useQuery({
    queryKey: queryKeys.detail(issue?.id ?? ""),
    queryFn: () => {
      if (!issue) throw new Error("No work item selected");
      return detail({ issueId: issue.id, projectId: issue.project.id });
    },
    enabled: issue !== null,
    staleTime: 30_000,
    retry: retryUnlessConfigError,
  });
}

export function useProjectMembersQuery(projectId: string, enabled: boolean) {
  const members = useRpc(projectMembers);
  return useQuery({
    queryKey: queryKeys.members(projectId),
    queryFn: async () => (await members({ projectId })).members,
    enabled,
    staleTime: 5 * 60_000,
    retry: retryUnlessConfigError,
  });
}

export function useSetAssigneesMutation() {
  const setAssignees = useRpc(issueSetAssignees);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setAssignees,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["plane", "issues"] });
      void queryClient.invalidateQueries({ queryKey: ["plane", "issue"] });
      void queryClient.invalidateQueries({ queryKey: ["plane", "search"] });
    },
  });
}

export function useMySprintQuery(enabled: boolean, userId: string | null) {
  const mine = useRpc(sprintMine);
  return useQuery({
    queryKey: queryKeys.sprint(userId),
    queryFn: async () => (await mine({ userId })).sprints,
    enabled,
    staleTime: 60_000,
    retry: retryUnlessConfigError,
  });
}

export function useSprintPeopleQuery(enabled: boolean) {
  const people = useRpc(sprintPeople);
  return useQuery({
    queryKey: queryKeys.sprintPeople,
    queryFn: async () => (await people({})).people,
    enabled,
    staleTime: 5 * 60_000,
    retry: retryUnlessConfigError,
  });
}

export function useProjectStatesQuery(projectId: string, enabled: boolean) {
  const states = useRpc(projectStates);
  return useQuery({
    queryKey: queryKeys.states(projectId),
    queryFn: async () => (await states({ projectId })).states,
    enabled,
    staleTime: 5 * 60_000,
    retry: retryUnlessConfigError,
  });
}

export function useSetStateMutation() {
  const setState = useRpc(issueSetState);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setState,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["plane", "issues"] });
      void queryClient.invalidateQueries({ queryKey: ["plane", "issue"] });
      void queryClient.invalidateQueries({ queryKey: ["plane", "search"] });
    },
  });
}

/** Fire-and-forget: app-side failures otherwise never reach `paseo plugin logs`. */
export function useClientLog() {
  const log = useRpc(clientLog);
  return useCallback(
    (level: "info" | "warn" | "error", message: string) => {
      void log({ level, message: message.slice(0, 4000) }).catch(() => {});
    },
    [log],
  );
}

export function useIssueStartMutation() {
  const start = useRpc(issueStart);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: start,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["plane", "issues"] });
      void queryClient.invalidateQueries({ queryKey: ["plane", "issue"] });
    },
  });
}

export function useCredentialsMutations() {
  const set = useRpc(credentialsSet);
  const clear = useRpc(credentialsClear);
  const queryClient = useQueryClient();
  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["plane"] });
  }, [queryClient]);
  const save = useMutation({
    mutationFn: (input: { token: string; instanceUrl?: string; workspaceSlug?: string }) =>
      set(input),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.status, status);
      settle();
    },
  });
  const remove = useMutation({
    mutationFn: () => clear({}),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.status, status);
      settle();
    },
  });
  return { save, remove };
}

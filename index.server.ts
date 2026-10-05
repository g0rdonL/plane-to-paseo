import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  attachmentsSearchHandler,
  clientLogHandler,
  credentialsClearHandler,
  credentialsSetHandler,
  credentialsStatusHandler,
  issueDetailHandler,
  issueSetAssigneesHandler,
  issueSetStateHandler,
  issueStartHandler,
  issuesListHandler,
  issuesSearchHandler,
  projectMembersHandler,
  projectStatesHandler,
  sprintMineHandler,
  sprintPeopleHandler,
} from "./server/handlers";
import { startNotifier } from "./server/notifications/poller";
import {
  attachmentsSearch,
  clientLog,
  credentialsClear,
  credentialsSet,
  credentialsStatus,
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
} from "./shared/contracts";
import { preferences } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferences);
  server.handle(credentialsStatus, credentialsStatusHandler);
  server.handle(credentialsSet, credentialsSetHandler);
  server.handle(credentialsClear, credentialsClearHandler);
  server.handle(issuesList, issuesListHandler);
  server.handle(issuesSearch, issuesSearchHandler);
  server.handle(issueDetail, issueDetailHandler);
  server.handle(issueStart, issueStartHandler);
  server.handle(projectMembers, projectMembersHandler);
  server.handle(issueSetAssignees, issueSetAssigneesHandler);
  server.handle(projectStates, projectStatesHandler);
  server.handle(issueSetState, issueSetStateHandler);
  server.handle(clientLog, clientLogHandler);
  server.handle(sprintMine, sprintMineHandler);
  server.handle(sprintPeople, sprintPeopleHandler);
  server.handle(attachmentsSearch, attachmentsSearchHandler);
  // Publishes assignments, comments, and state changes to the Plugin Launcher inbox.
  const stopNotifier = startNotifier();
  return () => stopNotifier();
}

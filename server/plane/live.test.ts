import { describe, expect, it } from "vitest";
import { createPlaneClient } from "./client";
import { PlaneService } from "./service";

/**
 * Read-only smoke test against a real Plane instance. Skipped unless PLANE_API_KEY is set:
 *   PLANE_API_KEY=plane_api_… npx vitest run live
 * Optional: PLANE_URL (default https://plane.aight.to), PLANE_WORKSPACE (default aight).
 * It validates the response shapes that the unit tests fake. Nothing is written.
 */
const token = process.env.PLANE_API_KEY ?? process.env.PLANE_API_TOKEN ?? "";
const instanceUrl = process.env.PLANE_URL ?? "https://plane.aight.to";
const workspaceSlug = process.env.PLANE_WORKSPACE ?? "aight";

describe.skipIf(!token)("Plane live API", () => {
  const service = new PlaneService({
    client: createPlaneClient({ token, instanceUrl }),
    workspaceSlug,
  });

  it("bootstraps viewer, members and projects", async () => {
    const bootstrap = await service.bootstrap(true);
    expect(bootstrap.viewer.id).toBeTruthy();
    expect(bootstrap.members.size).toBeGreaterThan(0);
    expect(bootstrap.projects.length).toBeGreaterThan(0);
    console.log(
      `[live] viewer=${bootstrap.viewer.name} members=${bootstrap.members.size} projects=${bootstrap.projects.map((p) => p.key).join(",")}`,
    );
  });

  it("lists work items across projects with every mapped field", async () => {
    const result = await service.listIssues({ includeClosed: true, refresh: true });
    for (const issue of result.issues) {
      expect(issue.identifier).toMatch(/^[A-Z0-9]+-\d+$/);
      expect(issue.state.name).not.toBe("Unknown");
      expect(["triage", "backlog", "unstarted", "started", "completed", "cancelled"]).toContain(
        issue.state.type,
      );
    }
    const perProject = new Map<string, number>();
    for (const issue of result.issues) {
      perProject.set(issue.project.key, (perProject.get(issue.project.key) ?? 0) + 1);
    }
    console.log(
      `[live] ${result.issues.length} work items (truncated=${result.truncated}): ${[...perProject].map(([k, n]) => `${k}=${n}`).join(" ")}`,
    );
  });

  it("finds a work item by identifier and by title search", async () => {
    const { issues } = await service.listIssues({ includeClosed: true, refresh: false });
    const sample = issues[0];
    if (!sample) return;
    const exact = await service.searchIssues(sample.identifier);
    expect(exact[0]?.id).toBe(sample.id);
    const word = sample.title.split(/\s+/).find((w) => w.length > 3) ?? sample.title;
    const byTitle = await service.searchIssues(word);
    expect(byTitle.length).toBeGreaterThan(0);
  });

  it("reads the sprints when the fork's endpoint exists", async () => {
    const sprints = await service.mySprints();
    console.log(
      `[live] sprints: ${sprints.length ? sprints.map((s) => `${s.label} (${s.issueIds.length})`).join(", ") : "none / endpoint absent"}`,
    );
    for (const sprint of sprints) expect(sprint.startDate <= sprint.endDate).toBe(true);
  });

  it("loads a detail with comments, links, and images", async () => {
    const { issues } = await service.listIssues({ includeClosed: true, refresh: false });
    const sample = issues[0];
    if (!sample) return;
    const detail = await service.issueDetail({ issueId: sample.id, projectId: sample.project.id });
    expect(detail.identifier).toBe(sample.identifier);
    console.log(
      `[live] ${detail.identifier}: ${detail.comments.length} comments, ${detail.attachments.length} links/files, ${detail.images.filter((i) => i.data).length}/${detail.images.length} images`,
    );
  }, 60_000);
});

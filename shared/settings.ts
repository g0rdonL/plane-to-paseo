import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ASSIGNEE_FILTERS, SORT_KEYS } from "./issue-query";
import { DEFAULT_PROMPT_TEMPLATE } from "./prompt";

/**
 * Non-secret, host-shared preferences. The Plane API token is deliberately NOT here: settings
 * documents are readable by every client connected to the daemon. The token lives daemon-side
 * behind the `plane.credentials.*` RPCs.
 */
export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    includeClosed: z.boolean().default(false),
    defaultSort: z.enum(SORT_KEYS).default("updated"),
    /** Assignee scope applied when the browser first opens. */
    defaultAssignee: z.enum(ASSIGNEE_FILTERS).default("me-or-unassigned"),
    /** Issues assigned to the viewer are listed before everything else. */
    mineFirst: z.boolean().default(true),
    moveToStarted: z.boolean().default(true),
    assignToMe: z.boolean().default(true),
    /** `provider/model`, or null for the Paseo default. */
    defaultModel: z.string().nullable().default(null),
    /** Last agent mode chosen per provider (e.g. claude → bypassPermissions). */
    defaultModes: z.record(z.string(), z.string()).default({}),
    /** Root path of the project used for the last hand-off; preselected next time. */
    lastProjectPath: z.string().nullable().default(null),
    promptTemplate: z.string().default(DEFAULT_PROMPT_TEMPLATE),
  }),
});

export type Preferences = z.output<typeof preferences.schema>;
export const DEFAULT_PREFERENCES: Preferences = preferences.schema.parse({});

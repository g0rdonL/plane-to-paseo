# plane-to-paseo

A [Paseo](https://paseo.sh) plugin for a self-hosted [Plane](https://plane.so) workspace. Browse,
filter, and search work items across every project, change their status and assignees, and hand
one to a fresh Paseo worktree with the whole ticket (description, comments, links, images) as the
agent's first message.

Ported from [ChrisjanWust/linear-to-paseo](https://github.com/ChrisjanWust/linear-to-paseo) (MIT).
The UI shell is the same; the data layer is new and targets Plane's v1 REST API.

## Features

- **Browser**: work items from every active project, newest first. Filter by project, state,
  assignee (mine / unassigned / specific people), priority, and label; filters combine with AND.
  Local search covers identifier, title, labels, and description; a full-text fallback asks Plane.
- **Detail**: description and comments converted from Plane's HTML to Markdown, parent, links,
  file attachments, and inline images.
- **Edit in place**: tap the status chip to move a work item to another state in its project; tap
  **Edit** beside the assignees to pick from the project's members.
- **Hand-off**: create a worktree workspace (or use an existing one), choose the model and agent
  mode, edit the prompt, and start. Optional write-back moves the item to the project's first
  "started" state, adds you as an assignee, and posts a comment linking the agent.
- **Composer attachment**: attach a Plane work item to any message.

## Requirements

- Paseo daemon and app **0.10.3** or newer, with plugins enabled.
- A Plane instance with the v1 API (tested against Plane Community Edition v1.4.2).
- A Plane personal access token for a member of the workspace.

## Install

```bash
git clone git@github.com:g0rdonL/plane-to-paseo.git
cd plane-to-paseo
npm install            # .npmrc sets legacy-peer-deps; npm 10.9 crashes without it
npm run typecheck
paseo plugin install "$PWD"
paseo plugin ls        # plane-to-paseo should report "running"
```

Then in Plane, open **Profile settings → Developer → API tokens**
(`https://<instance>/settings/profile/api-tokens/`), create a token, and paste it in Paseo under
**Settings → Plugins → Plane**. Instance URL and workspace slug default to
`https://plane.aight.to` and `aight`; fill them in for any other instance.

The token is validated before it is saved, then stored daemon-side in
`$PASEO_HOME/plugins/plane-to-paseo/credentials.json` with mode `0600`. It never reaches the app,
the settings document, or the logs. `PLANE_API_KEY` (plus optional `PLANE_URL` and
`PLANE_WORKSPACE`) in the daemon's environment overrides the file.

## Agent mode

The hand-off form lists the chosen provider's modes and remembers the last one per provider. With
nothing remembered it uses the provider's default (Auto for Claude). Bypass-style modes are marked
because the prompt is ticket text: anyone who can edit or comment on a work item is writing
instructions for an agent that will run without approval prompts.

## Development

```bash
npm run typecheck
npm test               # unit tests against a local HTTP fake of Plane v1
npm run check          # biome lint + format
paseo plugin reload plane-to-paseo
paseo plugin logs plane-to-paseo
```

Live smoke test, read-only, against a real instance. Read the token from the stored credentials
so it never appears on screen:

```bash
PLANE_API_KEY="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.paseo/plugins/plane-to-paseo/credentials.json","utf8")).token)')" \
  npx vitest run live
```

Layout follows Paseo's runtime boundaries: `client/` runs in the app (React Native primitives
only), `server/` runs in the daemon subprocess (credentials and every Plane call), `shared/` holds
Zod contracts and pure functions.

## How it talks to Plane

- **Fan-out listing.** Plane CE has no cross-project query (`advanced-search` is Commercial
  Edition only) and its list endpoint rejects filters, so the daemon lists each project's work
  items (up to 500 each) and filters locally. Results are cached for 15 seconds; projects, states,
  labels, and members for 5 minutes.
- **Images.** `<image-component src="<asset id>">` becomes the instance's asset API URL in the
  Markdown. At download time the daemon trades it for a short-lived presigned URL and fetches the
  bytes without the API key. At most 10 images, 8 MB each, 20 seconds total, sent to the agent as
  attachments.
- **Write-back.** Never pulls an item that is already started or done back to "started"; adds the
  viewer to existing assignees instead of replacing them.

## Troubleshooting

- **Plugin shows `failed`.** Check `paseo plugin ls` for the error and `paseo plugin logs
  plane-to-paseo` for output. Plugin RPC names must match `^[a-z][a-z0-9._-]*$`; a camelCase
  name stops the whole plugin from loading.
- **A button seems to do nothing.** App-side steps of the hand-off are mirrored into the plugin
  log as `[plane-to-paseo:app] …`, including the chosen model, mode, and target, and any error
  with its stack.
- **"Plane returned a non-JSON response".** The instance URL points at Plane's web app or a
  proxy page rather than the API host.
- **Detail fails schema validation.** Plane's serializers have quirks; for example
  `expand=parent` returns `{}` rather than `null` when there is no parent. Add the case to the
  fake in `server/plane/service.test.ts` and widen the schema in `server/plane/service.ts`.
- **Agent started in "Always Ask".** Choose the mode in the hand-off form; it is remembered per
  provider.

## Not yet supported

Cycles and modules, estimates (Plane stores point ids), creating work items, real-time updates,
and more than one workspace at a time.

## License

MIT. See [LICENSE](LICENSE).

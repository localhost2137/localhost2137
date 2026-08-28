# `@localhost2137/slack`

A stateful local Slack workspace plugin for localhost2137. The current compatibility slice covers a
public-channel bot workflow through Slack-shaped HTTP and signed Events API callbacks.

## Install

Merge this native dependency permission into the project workspace file before installing:

```yaml title="pnpm-workspace.yaml"
allowBuilds:
  better-sqlite3: true
```

```sh
pnpm add -D localhost2137 @localhost2137/slack hono@^4.13.4 zod@^4.4.3
pnpm add @slack/bolt@5.0.0
```

## Mount

```ts title="localhost.config.ts"
import { slack } from "@localhost2137/slack";
import { defineConfig } from "localhost2137";

export default defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
	services: {
		slack: slack({
			config: {
				botToken: "xoxb-local-crash-course",
				eventsUrl: null,
				signingSecret: "local-crash-course-signing-secret",
				workspaceName: "Local workspace",
			},
			seed: {
				users: [{ id: "U_ADA", name: "Ada" }],
				channels: [{ id: "C_GENERAL", name: "general", members: ["U_ADA"] }],
			},
		}),
	},
});
```

```sh
pnpm exec localhost doctor --json
pnpm exec localhost dev
```

The connection exposes `apiUrl`, `botToken`, and `signingSecret`, with environment names
`SLACK_API_URL`, `SLACK_BOT_TOKEN`, and `SLACK_SIGNING_SECRET`. Pass `apiUrl` to Bolt as
`clientOptions.slackApiUrl`. Set `eventsUrl` to the application's listening Events API path when the
scenario needs callbacks.

## Open the workspace

`localhost dev` prints a URL for every mounted service. Open the Slack URL in a browser:

```text
services:
  slack: http://127.0.0.1:2137/dev/slack
```

The dashboard has no sign-in. Choose a local user, browse public channels and their latest messages,
create or join a channel, and send a message. A dashboard message follows the same event-delivery
path as `sendMessage`, so it can trigger your application's signed Events API callback when
`eventsUrl` is configured.

The dashboard, CLI, Web API, and test API are different views of the same instance state. For
example, run these commands while the dashboard is open:

```sh
pnpm exec localhost exec slack create-channel --name incidents
pnpm exec localhost exec slack add-user-to-channel --channel incidents --user Ada
pnpm exec localhost exec slack send-message --channel incidents --from Ada --text "deploy failed"
```

The new channel and message normally appear within about one second without reloading the page.
Polling pauses while the tab is hidden and refreshes when it becomes visible again.

The dashboard shows public channels and the latest 200 messages in the selected channel. It does not
add support for direct messages, private channels, reactions, editing, files, or the other Slack
features outside the compatibility table below. The UI and its fonts ship in the plugin package; it
does not contact Slack or a CDN. Because there is no dashboard authentication, keep the runtime in a
trusted local environment.

## Supported surface

| Web API | Control operations |
| --- | --- |
| `auth.test` | `createUser` |
| `users.list` | `createChannel` |
| `conversations.list` | `addUserToChannel` |
| `conversations.members` | `sendMessage` |
| `conversations.history` | `listMessages` |
| `chat.postMessage` | |

```sh
pnpm exec localhost describe slack --json
pnpm exec localhost exec slack --help
```

The checked Bolt 5.0.0 path receives a signed `message` event, replies through
`chat.postMessage`, waits with `instance.idle()`, and inspects the shared world. Events delivery has
at most four attempts driven by explicit clock advancement; there is no wall-clock retry scheduler.

The [full Slack plugin reference](https://localhost2137.dev/first-party/slack) contains the complete
Bolt adapter and executable end-to-end test, exact inputs, pagination, signatures, retry policy,
persistence, and deliberate differences.

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

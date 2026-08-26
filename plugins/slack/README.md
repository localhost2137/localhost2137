# `@localhost2137/slack`

A stateful local Slack workspace for localhost2137. It gives applications and coding agents a real
HTTP service, typed control operations, SQLite persistence, and signed Events API callbacks without
a Slack account, OAuth setup, or real credentials.

## Configure

Use ESM application metadata (`"type": "module"`) when loading a TypeScript
`localhost.config.ts`. A newly initialized CommonJS package can use `localhost.config.mjs` instead.

```ts
import { slack } from "@localhost2137/slack";
import { defineConfig } from "localhost2137";

export default defineConfig({
	services: {
		slack: slack({
			config: {
				workspaceName: "Acme Local",
				botToken: "xoxb-local-acme",
				signingSecret: "local-signing-secret",
				eventsUrl: "http://127.0.0.1:3000/slack/events",
			},
			seed: {
				users: [{ id: "U_ADA", name: "Ada", admin: true }],
				channels: [{ id: "C_GENERAL", name: "general", members: ["U_ADA"] }],
			},
		}),
	},
});
```

`eventsUrl` defaults to `null`. Fresh instances contain only the installed local bot identity;
declared seed data is applied only by an explicit seed/reset-with-seed request.

Connection metadata exposes `apiUrl`, `botToken`, and `signingSecret`. The environment projection is
`SLACK_API_URL`, `SLACK_BOT_TOKEN`, and `SLACK_SIGNING_SECRET`. `apiUrl` ends in `/api/` and can be
passed directly as the official Slack SDK's `slackApiUrl`.

## Supported Web API surface

All recognized Slack platform errors return HTTP 200 with `{ ok: false, error }`, matching how the
official Web API client distinguishes platform errors from transport errors. Bearer authentication
is supported for every method; a form-body `token` is also accepted for compatibility. JSON and
`application/x-www-form-urlencoded` POST bodies are supported, and list methods also accept query
parameters. Cursor pagination is opaque, method/filter-bound, and based on deterministic keys.

| Method | Supported behavior |
| --- | --- |
| `auth.test` | local workspace/bot identity, including `bot_id` for Bolt initialization |
| `users.list` | installed bot plus local users, stable cursor pagination |
| `conversations.list` | public channels only, membership and member counts, stable pagination |
| `conversations.members` | channel membership IDs, stable pagination |
| `conversations.history` | newest-first messages, cursor/bounds pagination, thread fields |
| `chat.postMessage` | bot messages, optional `thread_ts`, Events callback emission |

Deliberate v0.1 differences:

- no HTTPS, OAuth, scopes, rate limits, enterprise/grid, DMs, private channels, files, reactions,
  rich blocks/attachments, presence, search, or message editing/deletion APIs;
- channel posting requires membership, but scope authorization is not emulated;
- bot and user IDs, event IDs, and Slack timestamps are deterministic database sequences;
- `U000000` and `localhost2137-bot` are reserved for the installed bot; upgrades relocate a
  conflicting persisted human to the next generated user ID, rewrite its references
  transactionally, and preserve a conflicting human name as
  `localhost2137-bot-preserved-{userId}` (with a deterministic numeric suffix on collision);
- only the configured bot token is public in v0.1; local users do not receive tokens;
- public channels are the only accepted `conversations.list` type;
- Slack Events retries and retry headers are not emulated until durable virtual-time retries exist.

## Control operations

| Operation | Purpose |
| --- | --- |
| `createUser` | create a user with an optional admin flag |
| `createChannel` | create a public channel; the installed bot joins automatically |
| `addUserToChannel` | add a user by ID or exact name, idempotently |
| `sendMessage` | simulate a member message and enqueue one Events API callback |
| `listMessages` | inspect newest-first channel messages |

Public Web API routes and control operations call the same `SlackService`; neither adapter calls the
other. Expected operation failures use structured localhost2137 errors, while public routes map the
same domain errors to Slack-shaped responses.

## Events API delivery

Each message event gets one stable `event_id`. Delivery uses the exact compact JSON bytes signed by
`v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{body}")` and sends
`X-Slack-Request-Timestamp` plus `X-Slack-Signature`. One three-second attempt runs through
`ctx.fetch` and is tracked by the instance. Success, non-2xx, timeout, and transport outcomes are
persisted in SQLite. Generic outbound logs describe transport acceptance, while the Slack plugin
emits a separate safe semantic outcome (`eventId`, `outcome`, optional `statusCode`, and classified
`error`) only after the terminal delivery state is persisted. `instance.idle()` waits for delivery
work and surfaces failed attempts. There are no automatic retries in v0.1.

Use real clock mode with Bolt's default replay-window verification. Pinned-clock signature tests
should verify the supplied virtual timestamp directly instead of comparing it with wall time.

## Implementation map

The package keeps dependencies one-way:

```text
api + operations -> SlackService -> repositories -> better-sqlite3
events adapter ---------------------> delivery repository
lifecycle --------------------------> database resource owner
```

Raw parameterized SQL and four explicit migrations own the schema. Repositories map rows to domain
records. `SlackDatabase` is the only connection resource owner, closes idempotently, enables foreign
keys/WAL, and provides the transaction boundary for multi-row message/event creation. The plugin
never imports runtime internals and keeps no module-global instance state.

Run the real plugin contract and the official Bolt example with:

```sh
pnpm exec vitest run plugins/slack/test
pnpm --filter @localhost2137/example-slack-ping-bot test
```

# `@localhost2137/slack`

A stateful local Slack workspace for localhost2137. It provides a provider-shaped HTTP service,
typed control operations, SQLite persistence, and signed Events API callbacks without a Slack
account, OAuth setup, or real credentials.

## Install

Install the runtime, plugin, and runtime host peers as development dependencies. Install Bolt as an
application dependency:

```sh
pnpm add -D localhost2137 @localhost2137/slack hono@^4.13.4 zod@^4.4.3
pnpm add @slack/bolt
```

Omit the second command when the application already provides its supported Slack client.

## Configure

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

Deliberate differences:

- no HTTPS, OAuth, scopes, rate limits, enterprise/grid, DMs, private channels, files, reactions,
  rich blocks/attachments, presence, search, or message editing/deletion APIs;
- channel posting requires membership, but scope authorization is not emulated;
- bot and user IDs, event IDs, and Slack timestamps are deterministic database sequences;
- `U000000` and `localhost2137-bot` identify the installed bot and are unavailable for local human
  users;
- only the installed bot can authenticate to the Web API, using the configured bot token;
- public channels are the only accepted `conversations.list` type;
- Events retries are driven only by explicit virtual-time advancement; there is no wall-clock
  scheduler.

## Control operations

| Operation | Purpose |
| --- | --- |
| `createUser` | create a user with an optional admin flag |
| `createChannel` | create a public channel; the installed bot joins automatically |
| `addUserToChannel` | add a user by ID or exact name, idempotently |
| `sendMessage` | simulate a member message; its result includes the enqueued callback `eventId`, or `null` when Events are disabled |
| `listMessages` | inspect newest-first channel messages; list items omit delivery-only `eventId` |

Public Web API routes and control operations call the same `SlackService`; neither adapter calls the
other. Expected operation failures use structured localhost2137 errors, while public routes map the
same domain errors to Slack-shaped responses.

## Events API delivery

Each message event gets one stable `event_id`. Delivery uses the exact compact JSON bytes signed by
`v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{body}")` and sends
`X-Slack-Request-Timestamp` plus `X-Slack-Signature`. Each three-second attempt runs through
`ctx.fetch` and is tracked by the instance. Success, non-2xx, timeout, and transport outcomes are
persisted in SQLite. Generic outbound logs describe transport acceptance, while the Slack plugin
emits a separate safe semantic outcome only after the attempt result and next deadline are stored.
`instance.idle()` waits for delivery work and surfaces a failed initial attempt.

Retries follow Slack's documented bounded schedule: retry 1 is due immediately, retry 2 one minute
later, and retry 3 five minutes after that. Because localhost2137 has no real-time scheduler, the
immediate retry runs on the next positive `instance.clock.advance(...)`; one large advance drains
every crossed deadline. Retries reuse the stable event body and add `X-Slack-Retry-Num` plus a
locally meaningful `X-Slack-Retry-Reason`: `http_timeout`, `connection_failed`, `http_error`, or
`unknown_error`. A failed response with `X-Slack-No-Retry: 1` suppresses remaining attempts. This
matches the relevant subset of Slack's
[Events API retry contract](https://docs.slack.dev/apis/events-api/), while deliberately omitting
redirect and TLS-specific failure classifications that the local transport does not expose.

Use real clock mode with Bolt's default replay-window verification. Pinned-clock signature tests
should verify the supplied virtual timestamp directly instead of comparing it with wall time.

The [full plugin reference](https://localhost2137.dev/first-party/slack) documents exact operation
inputs, supported Bolt evidence, retry behavior, and deliberate differences.

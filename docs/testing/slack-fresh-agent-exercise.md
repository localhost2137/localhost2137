# Slack fresh-agent empty-app exercise

## Scope and prohibitions

This is an external-consumer validation performed on 2026-08-26 from an empty directory under
`/private/tmp`. I did **not** inspect `plugins/slack/src`, `plugins/slack/test`, Git history,
`concept.md`, `design/`, `IMPLEMENTATION_PLAN.md`, or any other internal implementation source.
I did not copy application code from the repository example.

Discovery was limited to these user-facing/package-consumer surfaces:

- `plugins/slack/README.md`;
- `docs/testing/slack-agent-walkthrough.md`;
- `examples/slack-ping-bot/README.md` and its public `package.json` dependency inventory;
- root and published-package `package.json` metadata;
- `localhost --help`, subcommand help, `doctor`, `describe`, `env`, and `logs` output;
- tarball file inventories and public package metadata produced by `pnpm pack`.

All dependency management and application execution used pnpm. The only workspace file created or
edited by this exercise is this report. The temporary application was not added to the repository,
and no commit was made.

## Environment

Observed verbatim:

```text
$ node --version
v26.4.0
$ pnpm --version
11.18.0
$ uname -srm
Darwin 25.5.0 arm64
$ mktemp -d /private/tmp/slack-fresh-agent.XXXXXX
/private/tmp/slack-fresh-agent.N2i3KR
```

The locally packed consumer versions were `localhost2137@0.0.0` and
`@localhost2137/slack@0.0.0`; the official SDK resolved to `@slack/bolt@5.0.0`.

## Discovery and package installation

The Slack README documented `slack(...)`, the three `SLACK_*` connection values, the `/api/`
shape needed by Bolt's `slackApiUrl`, and the five control operations. CLI help independently
exposed the runtime workflow:

```text
$ pnpm exec localhost --help
Usage: localhost [options] [command]

Commands:
  dev [options]                 start the project runtime
  describe [options] [service]  describe configured services and operations
  instance [options]            manage isolated worlds
  seed [options]                apply configured plugin and scenario seed data
  env [options]                 render app-facing connection environment
  run [options] <command...>    run a command with app-facing connection environment
  logs [options] [service]      inspect bounded runtime logs
  clock [options]               inspect instance time
  doctor [options]              diagnose project runtime discovery and storage
```

I packed the packages rather than linking the temporary app into the workspace:

```sh
pnpm --filter localhost2137 pack \
  --pack-destination /private/tmp/slack-fresh-agent.N2i3KR
pnpm --filter @localhost2137/slack pack \
  --pack-destination /private/tmp/slack-fresh-agent.N2i3KR
```

Observed verbatim excerpts:

```text
Tarball Details
/private/tmp/slack-fresh-agent.N2i3KR/localhost2137-0.0.0.tgz

Tarball Details
/private/tmp/slack-fresh-agent.N2i3KR/localhost2137-slack-0.0.0.tgz
```

From the empty directory:

```sh
pnpm init
pnpm add ./localhost2137-0.0.0.tgz \
  ./localhost2137-slack-0.0.0.tgz \
  @slack/bolt@^5.0.0
```

The first `pnpm add` was blocked by sandboxed DNS. Observed verbatim (two non-adjacent lines):

```text
WARN  GET https://registry.npmjs.org/@slack%2Fbolt error (ENOTFOUND). Will retry in 10 seconds. 2 retries left.
ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/@slack%2Fbolt: request to https://registry.npmjs.org/@slack%2Fbolt failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
```

I repeated the same command with network permission. Compact observed excerpts follow; `...` marks
omitted progress/build lines and the native-build path prefix is shortened:

```text
Packages: +121
...
better-sqlite3 install: gyp info ok
...
dependencies:
+ @localhost2137/slack 0.0.0
+ @slack/bolt 5.0.0
+ localhost2137 0.0.0

Done in 4s
```

Interpretation: installation succeeded as an isolated tarball consumer, including a native
`better-sqlite3` build. The DNS error was an execution-sandbox restriction, not a package failure.

## Configuration and an ESM setup pitfall

I first wrote the documented TypeScript-shaped config as `localhost.config.ts`:

```ts
import { slack } from "@localhost2137/slack";
import { defineConfig } from "localhost2137";

export default defineConfig({
	services: {
		slack: slack({
			config: {
				workspaceName: "Fresh Agent Workspace",
				botToken: "xoxb-local-fresh-agent",
				signingSecret: "fresh-agent-signing-secret",
				eventsUrl: "http://127.0.0.1:33101/slack/events",
			},
		}),
	},
});
```

With the unmodified CommonJS-oriented `package.json` produced by `pnpm init`, it failed. Observed
verbatim:

```text
$ pnpm exec localhost describe slack --json
error: Failed to import localhost2137 config at /private/tmp/slack-fresh-agent.N2i3KR/localhost.config.ts.
```

`localhost doctor --json` reported `CONFIG_IMPORT_FAILED` but no underlying exception. An equivalent
`localhost.config.mjs` loaded successfully, so I used it with explicit `--config` for the running
exercise. Later, adding `tsx` as a direct dev dependency did **not** fix the TypeScript config:

```sh
pnpm add -D tsx@4.23.12
pnpm exec localhost --config ./localhost.config.ts doctor --json
```

A consumer-side diagnostic exposed the materially relevant error:

```sh
pnpm exec node --import tsx -e \
  "import('./localhost.config.ts').then(m => console.log('loaded default:', Boolean(m.default))).catch(e => { console.error(e); process.exit(1) })"
```

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in
/private/tmp/slack-fresh-agent.N2i3KR/node_modules/@localhost2137/slack/package.json
```

I then added this one field to the temporary app's `package.json` and ran `pnpm remove tsx` to
remove the diagnostic-only direct dependency:

```json
{
  "type": "module"
}
```

Compact observed excerpt after `pnpm remove tsx`; `...` marks omitted JSON fields:

```text
$ pnpm exec localhost --config ./localhost.config.ts doctor --json
{"config":{"fingerprint":"sha256:9947962328bb740f119dc56e5e2594f15a0121bb27f4989c9ddb3a95dc114184","path":"/private/tmp/slack-fresh-agent.N2i3KR/localhost.config.ts","loaded":true,"storageRoot":"/private/tmp/slack-fresh-agent.N2i3KR/.localhost2137"},"issues":[],"runtime":{"pid":39220,"state":"healthy","url":"http://127.0.0.1:42137"},"status":"ok",...}
```

Interpretation: the documented `.ts` form works when the empty app declares ESM mode; a direct
`tsx` dependency is unnecessary. A literal `pnpm init` app needs the extra `"type": "module"`
step, or it can use `.mjs`. The current CLI error hides this actionable cause.

## Runtime and control-surface introspection

The first sandboxed daemon attempt failed generically:

```text
$ pnpm exec localhost --config ./localhost.config.mjs dev \
    --host 127.0.0.1 --port 42137
error: Runtime HTTP startup failed.
```

A minimal loopback bind diagnostic returned `listen EPERM: operation not permitted
127.0.0.1:42138`. I repeated the daemon command with loopback-bind permission. Observed verbatim:

```text
localhost2137 ready
runtime: http://127.0.0.1:42137
instance: dev
services:
  slack: http://127.0.0.1:42137/dev/slack
environment: /private/tmp/slack-fresh-agent.N2i3KR/.localhost2137/.env
variables: SLACK_API_URL, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
```

The dynamic help came from the active service, not from application-side Slack knowledge:

```text
$ pnpm exec localhost --config ./localhost.config.mjs exec slack --help
Usage: localhost exec slack [options] [command]

Stateful Slack emulator for users, channels, messages, and Events API delivery

Commands:
  add-user-to-channel [options]  Add a local Slack user to a channel
  create-channel [options]       Create a public channel in the local Slack workspace
  create-user [options]          Create a user in the local Slack workspace
  list-messages [options]        Inspect messages in a local Slack channel
  send-message [options]         Send a user message and emit one local Slack Events API callback
```

`describe slack --json` exposed JSON Schemas for the same five operations. Material observed fields
included required `name` for `createUser`/`createChannel`, required `channel` and `user` for
`addUserToChannel`, and required `channel`, `from`, and `text` for `sendMessage`.

Connection projection was directly consumable by Bolt. Observed verbatim:

```text
$ pnpm exec localhost --config ./localhost.config.mjs env --format json
{
  "SLACK_API_URL": "http://127.0.0.1:42137/dev/slack/api/",
  "SLACK_BOT_TOKEN": "xoxb-local-fresh-agent",
  "SLACK_SIGNING_SECRET": "fresh-agent-signing-secret"
}
```

Interpretation: the CLI help, operation schemas, and connection metadata were sufficient to build
and drive the integration without inspecting plugin code.

## Minimal official Bolt app

The temporary app's complete `bot.mjs` was:

```js
import { App } from "@slack/bolt";

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	clientOptions: { slackApiUrl: process.env.SLACK_API_URL },
	endpoints: "/slack/events",
});

app.message(/^ping$/, async ({ message, say }) => {
	console.log(`observed message: ${message.text}`);
	await say("pong");
	console.log("sent reply: pong");
});

await app.start(33101);
console.log("Bolt listening on http://127.0.0.1:33101/slack/events");
```

I started it through the runtime's connection environment:

```text
$ pnpm exec localhost --config ./localhost.config.mjs run -- node bot.mjs
Bolt listening on http://127.0.0.1:33101/slack/events
```

Then I created the world and sent `ping` using only the introspected operations:

```sh
pnpm exec localhost --config ./localhost.config.mjs \
  exec slack create-user --name Ada --json
pnpm exec localhost --config ./localhost.config.mjs \
  exec slack create-channel --name general --json
pnpm exec localhost --config ./localhost.config.mjs \
  exec slack add-user-to-channel --channel general --user Ada --json
pnpm exec localhost --config ./localhost.config.mjs \
  exec slack send-message --channel general --from Ada --text ping --json
```

Observed verbatim:

```json
{"admin":false,"id":"U000001","name":"Ada"}
{"id":"C000001","name":"general"}
{"added":true,"channel":"C000001","user":"U000001"}
{"channel":"C000001","eventId":"Ev000001","id":"M000001","text":"ping","threadTs":null,"ts":"1787735748.496000","userId":"U000001"}
```

Observed verbatim from the still-running Bolt process:

```text
observed message: ping
sent reply: pong
```

Final control-plane observation, preserved verbatim from the exercise HEAD:

```text
$ pnpm exec localhost --config ./localhost.config.mjs \
    exec slack list-messages --channel general --json
[{"channel":"C000001","eventId":null,"id":"M000002","text":"pong","threadTs":null,"ts":"1787735748.512000","userId":"U000000"},{"channel":"C000001","eventId":null,"id":"M000001","text":"ping","threadTs":null,"ts":"1787735748.496000","userId":"U000001"}]
```

Contract correction (2026-08-26, `253e1ff`): the transcript above truthfully reflects the then-HEAD
schema. Current `listMessages` items omit the delivery-only `eventId`; the equivalent shape for that
historical state is shown below as an illustrative projection, not a second observed external run:

```json
[{"channel":"C000001","id":"M000002","text":"pong","threadTs":null,"ts":"1787735748.512000","userId":"U000000"},{"channel":"C000001","id":"M000001","text":"ping","threadTs":null,"ts":"1787735748.496000","userId":"U000001"}]
```

Material observed field excerpts from `localhost logs slack --tail 20 --json` (correlation IDs,
timestamps, and unrelated entries omitted):

```text
"method":"POST","path":"/dev/slack/api/auth.test","responseStatus":200
"method":"POST","responseStatus":200,"target":"http://127.0.0.1:33101/slack/events"
"message":"Outbound delivery succeeded."
"method":"POST","path":"/dev/slack/api/chat.postMessage","responseStatus":200
"message":"Public API request completed."
```

## Result and friction summary

Observed result: **pass**. A tarball-installed, official `@slack/bolt@5.0.0` app received the
emulator's Events API `ping`, ran its normal message listener, called Bolt's normal
`chat.postMessage` path, and produced a persisted bot-authored `pong`. The log also proves Bolt used
the emulated `auth.test` method and that the callback and Web API calls completed with HTTP 200.

Friction, separated by source:

1. **Application setup:** `pnpm init` did not create an ESM package. The documented TypeScript
   config then failed with a generic import error. Adding `"type": "module"` fixed it; adding a
   direct `tsx` dependency did not. The walkthrough should make the ESM prerequisite explicit or
   show `.mjs` as the zero-config alternative.
2. **CLI diagnostics:** `describe` and `doctor` surfaced `CONFIG_IMPORT_FAILED` but discarded the
   underlying `ERR_PACKAGE_PATH_NOT_EXPORTED`, making the setup error harder to identify.
3. **Execution environment:** registry DNS and loopback listening were initially denied by the
   sandbox (`ENOTFOUND` and `EPERM`). Repeating the same pnpm commands with the required permissions
   resolved both. These were not emulator defects.
4. **Native install:** `better-sqlite3` compiled locally during installation. It succeeded, but an
   empty consumer should expect a native build when no matching prebuild is available.

Both long-running processes were stopped with `Ctrl-C` after collecting the final evidence.
The exact disposable directory named above was then deleted, and neither callback/runtime port had
a listening process. Only the intentionally fake token and secret printed in this report remain.

# localhost2137

Run stateful emulators of external developer services on your machine. Your app—and the coding
agents working on it—can use ordinary SDKs and webhooks without provider accounts or API keys.

![A terminal session clones the Slack ping bot demo, starts localhost2137 and the bot, sends ping as Ada, then shows the bot's pong in channel history.](docs/assets/localhost2137-slack-demo.gif)

## Run the same demo

Requires Node.js 24 or newer and pnpm. These outputs come from a clean run against the published
packages. `…` marks omitted install progress or a machine-local path.

Install the CLI globally:

```sh
pnpm i -g localhost2137
```

```text
Packages: +9
+++++++++
…
+ localhost2137 0.0.1
```

Clone the published Slack demo. This also installs the demo's dependencies:

```sh
localhost demo clone slack-ping-bot
```

```text
…
Cloned slack-ping-bot to ./slack-ping-bot
Installed dependencies with pnpm.
```

In Terminal 1, enter the demo and start the emulator. Keep this terminal open:

```sh
cd slack-ping-bot
localhost dev
```

```text
localhost2137 ready
runtime: http://127.0.0.1:2137
instance: dev
services:
  slack: http://127.0.0.1:2137/dev/slack
…
variables: SLACK_API_URL, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
```

Open the printed Slack service URL to use the instance's local workspace dashboard; it runs with the
plugin and requires no sign-in.

That command loads this complete `localhost.config.ts`:

```ts
import { slack } from "@localhost2137/slack";
import { defineConfig } from "localhost2137";

export default defineConfig({
	services: {
		slack: slack({
			config: {
				botToken: "xoxb-local-ping-pong",
				eventsUrl: "http://127.0.0.1:3000/slack/events",
				signingSecret: "local-ping-pong-signing-secret",
				workspaceName: "Ping Pong Local",
			},
			seed: {
				channels: [{ id: "C_GENERAL", members: ["U_ADA"], name: "general" }],
				users: [{ id: "U_ADA", name: "Ada" }],
			},
		}),
	},
});
```

Those credential-shaped strings exist only inside the local world. The cloned Bolt bot uses the
ordinary Slack SDK, with one handler:

```ts
app.message(/^ping$/, async ({ say }) => {
	await say("pong");
});
```

In Terminal 2, enter the same directory and apply the seed data explicitly:

```sh
cd slack-ping-bot
localhost seed
```

```text
seeded dev
```

Start the bot through localhost2137 so it receives the local connection values. Keep this terminal
open too:

```sh
localhost run -- pnpm start
```

```text
…
> tsx src/main.ts

bot: http://127.0.0.1:3000/slack/events
```

In Terminal 3, send `ping` as Ada:

```sh
cd slack-ping-bot
localhost exec slack send-message \
  --channel general --from Ada --text ping --json
```

```json
{"channel":"C_GENERAL","id":"M000001","text":"ping","threadTs":null,"ts":"1787875174.049000","userId":"U_ADA","eventId":"Ev000001"}
```

Callback delivery is asynchronous. Read the channel; if the first result contains only `ping`,
repeat the same command until `pong` appears:

```sh
localhost exec slack list-messages --channel general
```

The fresh run used for this README returned this completed-delivery result:

```json
[
  {
    "channel": "C_GENERAL",
    "id": "M000002",
    "text": "pong",
    "threadTs": null,
    "ts": "1787875174.066000",
    "userId": "U000000"
  },
  {
    "channel": "C_GENERAL",
    "id": "M000001",
    "text": "ping",
    "threadTs": null,
    "ts": "1787875174.049000",
    "userId": "U_ADA"
  }
]
```

History is newest-first, so the bot's `pong` appears above Ada's earlier `ping`. Press Ctrl+C in
the bot and runtime terminals when finished.

[Read the localhost2137 documentation](https://localhost2137.dev/) for configuration, CLI, and
integration-testing guides.

## Add it to a project

```sh
pnpm add -D localhost2137 hono zod
pnpm exec localhost init
```

Then install an emulator plugin and add it to `localhost.config.ts`. Continue with
[configuration](https://localhost2137.dev/configuration), the
[CLI workflow](https://localhost2137.dev/cli), or
[integration testing](https://localhost2137.dev/testing).

# localhost2137

Run stateful emulators of external developer services on your machine. Your app—and the coding
agents working on it—can use ordinary SDKs and webhooks without provider accounts or API keys.

![A terminal session clones the Slack ping bot demo, starts localhost2137 and the bot, sends ping as Ada, then shows the bot's pong in channel history.](docs/assets/localhost2137-slack-demo.gif)

The recording starts in an empty directory and uses the published packages. No Slack account,
OAuth flow, or provider credential is involved.

<details>
<summary>Text version of the demo</summary>

1. `localhost demo clone` copies and installs the shipped Slack ping bot.
2. Its `localhost.config.ts` configures a local Slack service and seeds Ada in `#general`.
3. `localhost dev` starts the emulator; `localhost run -- pnpm start` gives the Bolt bot its local
   connection values.
4. Ada sends `ping`. The newest-first channel history shows the bot's `pong` above Ada's earlier
   message.

</details>

## Try the demo

Requires Node.js 24 or newer and pnpm.

```sh
pnpm dlx localhost2137 demo clone slack-ping-bot
cd slack-ping-bot
pnpm exec localhost dev
```

The cloned project includes the config, bot, integration test, and the remaining commands. Follow
its README, or [read the localhost2137 documentation](https://localhost2137.dev/).

## Add it to a project

```sh
pnpm add -D localhost2137 hono zod
pnpm exec localhost init
```

Then install an emulator plugin and add it to `localhost.config.ts`. Continue with
[configuration](https://localhost2137.dev/configuration), the
[CLI workflow](https://localhost2137.dev/cli), or
[integration testing](https://localhost2137.dev/testing).

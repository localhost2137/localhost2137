# Slack ping bot

This bot receives a signed local Slack event and replies through the normal Slack Bolt client. It
needs no Slack workspace, OAuth flow, or API key. Installing its dependencies may require registry
access; running the demo does not contact Slack.

Start the emulator:

```sh
pnpm exec localhost dev
```

In a second terminal, create Ada and `#general` from `localhost.config.ts`:

```sh
pnpm exec localhost seed
```

Start the bot with the local connection values:

```sh
pnpm exec localhost run -- pnpm start
```

Send `ping` as Ada, then inspect the shared channel state:

```sh
pnpm exec localhost exec slack send-message \
  --channel general --from Ada --text ping --json
pnpm exec localhost exec slack list-messages --channel general --json
```

After callback delivery completes, the second command shows both `ping` and the bot's `pong`. The
checked integration test waits for that boundary explicitly:

```sh
pnpm test
```

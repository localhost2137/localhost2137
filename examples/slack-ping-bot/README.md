# Slack Bolt ping-pong bot

This executable example proves the local Slack vertical slice with the official `@slack/bolt`
SDK. The bot receives a correctly signed Events API `message` callback, replies through Bolt's
normal Web API client, and is tested entirely against localhost2137. It needs no Slack account,
workspace, OAuth flow, or real credentials.

The example is an ESM package (`"type": "module"`). Empty apps created by `pnpm init` must add that
field before using a TypeScript `localhost.config.ts`, or use `localhost.config.mjs` instead.

```sh
pnpm --filter @localhost2137/example-slack-ping-bot test
```

The test allocates one bot callback port and one localhost2137 runtime port, creates an isolated
workspace instance, builds the required user/channel/membership through typed control operations,
and waits for nested delivery work with `instance.idle()` before inspecting both messages.

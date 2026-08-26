# Slack agent discover/build/test walkthrough

This is the recommended empty-app workflow for Phase 6. It uses only ordinary project files,
CLI/control introspection, typed operations, and the official Slack Bolt SDK. No Slack account,
workspace, OAuth flow, or real credential is involved. A separate agent independently exercised
the packed-package workflow and captured commands and observed output in
[`slack-fresh-agent-exercise.md`](./slack-fresh-agent-exercise.md).

## Reproduce the loop

1. Initialize an ESM app, then add `localhost2137`, `@localhost2137/slack`, and `@slack/bolt` with
   pnpm. A literal `pnpm init` needs `"type": "module"` added to `package.json` before a TypeScript
   `localhost.config.ts` can load; `localhost.config.mjs` is the zero-configuration alternative.
2. Write `localhost.config.ts` with one Slack service. Give it a fake `xoxb-` token, signing secret,
   and the app's explicit `/slack/events` URL.
3. Start `localhost dev`. The default `dev` world is empty except for the installed bot identity.
4. Discover the control surface instead of relying on service-specific agent knowledge:

   ```sh
   localhost exec slack --help
   localhost describe slack --json
   ```

   The declared production inventory is `createUser`, `createChannel`, `addUserToChannel`,
   `sendMessage`, and `listMessages`; descriptions and JSON Schemas come from those same operation
   descriptors. `sendMessage` reports its callback `eventId`; persisted `listMessages` items omit
   that delivery-only field.
5. Build a normal Bolt app with connection metadata:

   ```ts
   const app = new App({
     token: connection.botToken,
     signingSecret: connection.signingSecret,
     clientOptions: { slackApiUrl: connection.apiUrl },
     endpoints: "/slack/events",
   });
   app.message(/^ping$/, async ({ say }) => say("pong"));
   ```

6. Create the world and trigger behavior through the control plane:

   ```sh
   localhost exec slack create-user --name Ada --json
   localhost exec slack create-channel --name general --json
   localhost exec slack add-user-to-channel --channel general --user U000001 --json
   localhost exec slack send-message --channel general --from U000001 --text ping --json
   localhost exec slack list-messages --channel general --json
   ```

7. In tests, use one explicit `createTestRuntime`, one isolated instance, and `await instance.idle()`
   before asserting. The executable reference is
   [`examples/slack-ping-bot`](../../examples/slack-ping-bot/README.md).

## Recorded evidence

- The real Slack plugin passes every published plugin-testkit contract, including side-effect-free
  authoring, two-instance public API isolation, lifecycle recovery, tracked delivery, reset/seed,
  daemon restart, state upgrade, and future-version rejection.
- The Bolt test initializes itself through emulated `auth.test`, verifies a signed Events callback,
  replies through its normal form-encoded `chat.postMessage` call, ignores its own bot event, and
  observes `pong` through the typed control operation.
- Normalized compatibility fixtures cover every supported Web API method and both form/JSON/query
  transport paths.

## Friction found and resolved

- A stateful production `sendMessage` cannot run on an unseeded world. The plugin testkit originally
  offered no setup sequence for tracked-fetch/durability cases. Its generic fixture now declares
  public-operation `arrange` calls, run once at the correct boundary; no Slack invariant or test-only
  production operation was introduced.
- Bolt must know its callback port before the plugin config is materialized, while Bolt initializes
  against `auth.test` only after the runtime exists. The example reserves a loopback port, starts the
  runtime, then starts Bolt on that exact port. Runtime-level callback interception remains deferred.
- Bolt rejects request timestamps outside its wall-clock replay window. The complete Bolt example
  therefore uses real clock mode; pinned-clock tests verify the HMAC against the virtual timestamp
  directly.
- Slack SDKs expect a `slackApiUrl` ending at `/api/`. Connection metadata now exposes that exact
  shape, avoiding SDK-specific URL concatenation in application code.
- Realistic posting requires membership. The walkthrough makes membership explicit instead of
  silently auto-joining simulated users or weakening `not_in_channel` behavior.
- A clean `pnpm init` produces CommonJS application metadata. The fresh external exercise found
  that the CLI then reports only `CONFIG_IMPORT_FAILED` for the documented TypeScript config;
  declaring ESM fixes the config, while installing a direct `tsx` dependency does not. The setup
  prerequisite is now explicit above. Safely exposing the sanitized nested import cause is deferred
  to the generic CLI diagnostics work in Phase 8.

These are product findings rather than hidden test workarounds. They are preserved so the next
agent can reproduce the loop and understand the remaining v0.1 limitations from repository text.

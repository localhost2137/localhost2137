export const configCode = `import { defineConfig } from "localhost2137";
import { slack } from "@localhost2137/slack";

export default defineConfig({
  services: {
    slack: slack({
      config: {
        workspaceName: "Local workspace",
        botToken: "xoxb-local",
        signingSecret: "local-secret",
        eventsUrl:
          "http://localhost:3000/slack/events",
      },
      seed: {
        users: [{ id: "U_ADA", name: "Ada" }],
        channels: [{
          name: "general",
          members: ["U_ADA"],
        }],
      },
    }),
  },
});`;

export const botCode = `import { App } from "@slack/bolt";

const app = new App({
  token: "xoxb-local",
  signingSecret: "local-secret",
  clientOptions: {
    slackApiUrl:
      "http://localhost:2137/dev/slack/api/",
  },
  endpoints: "/slack/events",
});

app.message(/^ping$/, async ({ say }) => {
  await say("pong");
});

await app.start(3000);`;

export const setupPrompt = `Help me run the localhost2137 Slack ping-pong demo locally.

Read https://localhost2137.dev/first-party/slack for the supported Slack behavior. Check that Node.js 24 or later and pnpm are available.

Use a new directory for this demo. Do not overwrite an existing project. Install the CLI with pnpm add -g localhost2137, then run localhost demo clone slack-ping-bot. The clone command installs the demo dependencies.

In the demo directory:
1. Start pnpm exec localhost dev and leave it running.
2. Run pnpm exec localhost seed.
3. Start pnpm exec localhost run -- pnpm start and leave it running.
4. Open the printed Slack service URL, select Ada and #general, send ping, and confirm that the bot replies pong.
5. Run pnpm test to check the same round trip automatically.

Use the local credentials included with the demo; no Slack account or provider API key is needed. If a step fails, diagnose it and tell me what remains unresolved. Show me how to stop the bot and emulator when finished.`;

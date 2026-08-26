import { slack } from "@localhost2137/slack";
import { defineConfig } from "localhost2137";

export const slackAuthoringConfig = defineConfig({
	services: {
		slack: slack({
			config: {
				botToken: "xoxb-local-authoring",
				eventsUrl: null,
				signingSecret: "local-authoring-secret",
				workspaceName: "Authoring Workspace",
			},
		}),
	},
});

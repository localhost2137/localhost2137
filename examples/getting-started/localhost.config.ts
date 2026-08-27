import { slack } from "@localhost2137/slack";
import { defineConfig } from "localhost2137";

export default defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
	services: {
		slack: slack({
			config: {
				botToken: "xoxb-local-crash-course",
				eventsUrl: null,
				signingSecret: "local-crash-course-signing-secret",
				workspaceName: "Local workspace",
			},
			seed: {
				users: [{ id: "U_ADA", name: "Ada" }],
				channels: [{ id: "C_GENERAL", name: "general", members: ["U_ADA"] }],
			},
		}),
	},
});

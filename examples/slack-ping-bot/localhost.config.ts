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

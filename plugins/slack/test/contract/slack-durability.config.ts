import { appendFileSync } from "node:fs";
import { defineConfig } from "localhost2137";
import { createSlackPlugin } from "../../src/plugin.js";

const root = process.env.LOCALHOST2137_CONTRACT_STORAGE;
const eventsPath = process.env.LOCALHOST2137_CONTRACT_EVENTS;
const eventsUrl = process.env.LOCALHOST2137_CONTRACT_DELIVERY_URL;
const stateVersion = Number(process.env.LOCALHOST2137_CONTRACT_VERSION);
if (!root || !eventsPath || !eventsUrl || !Number.isSafeInteger(stateVersion) || stateVersion < 1) {
	throw new TypeError("Slack durability fixture environment is incomplete.");
}

export default defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-02T03:04:05.000Z" },
	services: {
		slack: createSlackPlugin({
			recordLifecycle(event) {
				if (!event.startsWith("update:")) return;
				appendFileSync(eventsPath, `${event}\n`, "utf8");
				if (process.env.LOCALHOST2137_CONTRACT_FAIL_UPDATE === "1") {
					throw new Error("injected Slack update failure");
				}
			},
			stateVersion,
		})({
			config: {
				botToken: "xoxb-local-contract",
				eventsUrl,
				signingSecret: "local-contract-secret",
				workspaceName: "Contract Workspace",
			},
			seed: { channels: [], users: [{ name: "Grace" }] },
		}),
	},
	storage: { dir: root },
});

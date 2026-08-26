import { defineConfig } from "localhost2137";
import { createFixturePlugin } from "./fixture-plugin.js";

const root = process.env.LOCALHOST2137_CONTRACT_STORAGE;
const eventsPath = process.env.LOCALHOST2137_CONTRACT_EVENTS;
const eventsUrl = process.env.LOCALHOST2137_CONTRACT_DELIVERY_URL;
const stateVersion = Number(process.env.LOCALHOST2137_CONTRACT_VERSION);
if (!root || !eventsPath || !eventsUrl || !Number.isSafeInteger(stateVersion) || stateVersion < 1) {
	throw new TypeError("Durability fixture environment is incomplete.");
}

export default defineConfig({
	services: {
		fixture: createFixturePlugin({
			eventsPath,
			failUpdate: process.env.LOCALHOST2137_CONTRACT_FAIL_UPDATE === "1",
			stateVersion,
		})({
			config: { eventsUrl, label: "isolated" },
			seed: { value: 7 },
		}),
	},
	storage: { dir: root },
});

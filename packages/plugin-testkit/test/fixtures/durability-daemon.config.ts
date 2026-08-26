import { defineConfig } from "localhost2137";
import { durabilityPlugin } from "./durability-plugin.js";

const root = process.env.LOCALHOST2137_CONTRACT_STORAGE;
const eventsPath = process.env.LOCALHOST2137_CONTRACT_EVENTS;
const stateVersion = Number(process.env.LOCALHOST2137_CONTRACT_VERSION);
if (!root || !eventsPath || !Number.isSafeInteger(stateVersion) || stateVersion < 1) {
	throw new TypeError("Durability fixture environment is incomplete.");
}

export default defineConfig({
	services: {
		durable: durabilityPlugin(stateVersion)({
			config: {
				eventsPath,
				failUpdate: process.env.LOCALHOST2137_CONTRACT_FAIL_UPDATE === "1",
			},
		}),
	},
	storage: { dir: root },
});

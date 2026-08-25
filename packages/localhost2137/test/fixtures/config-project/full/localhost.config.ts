import { defineConfig } from "localhost2137";
import { configurablePlugin } from "../../configurable-plugin.js";
import { pinnedStart, primaryToken } from "./settings.js";

export default defineConfig({
	clock: { mode: "pinned", startAt: pinnedStart },
	host: "localhost",
	port: 3217,
	services: {
		primary: configurablePlugin({
			config: { label: "Primary", nested: { enabled: false }, token: primaryToken },
			seed: { names: ["Alice"] },
		}),
		secondary: configurablePlugin({
			config: { label: "Secondary", token: "local-secondary-token" },
			exportEnv: false,
		}),
	},
	seed: async (scenario) => {
		await scenario.primary.createThing({ name: "from-scenario" });
	},
	storage: { dir: "state/local" },
});

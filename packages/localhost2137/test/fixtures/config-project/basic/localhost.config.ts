import { defineConfig } from "localhost2137";
import { configurablePlugin } from "../../configurable-plugin.js";

export default defineConfig({
	services: {
		fixture: configurablePlugin({
			config: { label: "Basic", token: "local-basic-token" },
		}),
	},
});

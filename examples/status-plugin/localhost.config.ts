import { defineConfig } from "localhost2137";
import { statusPlugin } from "./src/status-plugin.js";

export default defineConfig({
	services: {
		status: statusPlugin({ config: {} }),
	},
});

import { defineConfig } from "localhost2137";
import slackPlugin from "slack-localhost2137";

import { slackConfig } from "./localhost2137/slack/mockConfig.ts";

export default defineConfig({
	port: 2137, // 2137 by default
	plugins: [
		slackPlugin({
			name: "slack", //optinal, if you want to override, mmust be unique
			config: slackConfig,
		}),
	],
});

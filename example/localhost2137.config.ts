import { defineConfig } from "localhost2137";
import { slackPlugin } from "slack-localhost2137";

import { slackConfig } from "./localhost2137/slack/mockConfig.ts";

export default defineConfig(({ env = "dev" }) => 
	if (!["test-mock-1", "dev"].includes(env)) {
		throw new Error("Wrong environment!");
	}

	return {
		port: 2137, // 2137 by default
		plugins: [
			slackPlugin({
				name: "slack", //optinal, if you want to override, mmust be unique
				config: slackConfig,

				// 1. can be git ignored or not; We store db, s3, KV store or anything else plugin wants
				// 2. default value is "./localhost2137/{name}/dev"
				storagePath: `./localhost2137/slack/${env}`,

				// 1. if storagePath is empty, we create it by copying baseStoragePath there. It is just like a seed.
				// 2. baseStoragePath is supposed to be tracked by git, although it's developer call
				// 3. if baseStoragePath doesn't exist, we create empty one and run defined in slackPlugin migrations,
				// then immidiatelly after copy to storagePath
				// 4. default value is "./localhost2137/{name}/base"
				baseStoragePath: "./localhost2137/slack/base/" 
			}),
		],
	}
});

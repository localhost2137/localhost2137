import { type ConnectionMetadata, definePlugin, type PluginFactory } from "localhost2137";
import { createSlackApi } from "./api/routes.js";
import { slackConfigSchema, slackSeedSchema } from "./config.js";
import { createSlackLifecycle } from "./lifecycle.js";
import { createSlackOperations } from "./operations.js";
import type { SlackPluginDependencies } from "./plugin-dependencies.js";

interface SlackConnection extends ConnectionMetadata {
	readonly env: Readonly<{
		SLACK_API_URL: string;
		SLACK_BOT_TOKEN: string;
		SLACK_SIGNING_SECRET: string;
	}>;
	readonly values: Readonly<{
		apiUrl: string;
		botToken: string;
		signingSecret: string;
	}>;
}

type SlackOperations = ReturnType<typeof createSlackOperations>;

export type SlackPluginFactory = PluginFactory<
	typeof slackConfigSchema,
	typeof slackSeedSchema,
	SlackOperations,
	SlackConnection
>;

export function createSlackPlugin(dependencies: SlackPluginDependencies = {}): SlackPluginFactory {
	const stateVersion = dependencies.stateVersion ?? 6;
	if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) {
		throw new TypeError("Slack plugin stateVersion must be a positive safe integer.");
	}
	return definePlugin({
		api: createSlackApi(),
		configSchema: slackConfigSchema,
		connection: ({ baseUrl, config, instanceId, serviceKey }): SlackConnection => {
			const apiUrl = `${baseUrl}/${instanceId}/${serviceKey}/api/`;
			return Object.freeze({
				env: Object.freeze({
					SLACK_API_URL: apiUrl,
					SLACK_BOT_TOKEN: config.botToken,
					SLACK_SIGNING_SECRET: config.signingSecret,
				}),
				values: Object.freeze({
					apiUrl,
					botToken: config.botToken,
					signingSecret: config.signingSecret,
				}),
			});
		},
		description: "Stateful Slack emulator for users, channels, messages, and Events API delivery",
		id: "slack",
		lifecycle: createSlackLifecycle(dependencies),
		operations: createSlackOperations(dependencies),
		seedSchema: slackSeedSchema,
		stateVersion,
	});
}

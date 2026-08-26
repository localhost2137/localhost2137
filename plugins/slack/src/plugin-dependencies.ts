import type { BasePluginContext, RunningPluginContext } from "localhost2137";
import type { SlackConfig } from "./config.js";
import type { SlackState } from "./state.js";

type SlackLifecycleEvent = "create" | "seed" | "start" | "stop" | `update:${number}:${number}`;

export interface SlackPluginDependencies {
	readonly beforeCreate?: (context: BasePluginContext<SlackConfig>) => void;
	readonly beforeOperation?: (
		operation: string,
		context: RunningPluginContext<SlackState, SlackConfig>,
	) => void;
	readonly deliveryTimeoutMs?: number;
	readonly recordLifecycle?: (event: SlackLifecycleEvent) => void;
	readonly stateVersion?: number;
	transformOperationResult?<Value>(operation: string, value: Value): Value;
}

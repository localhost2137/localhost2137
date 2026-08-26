import type { BasePluginContext, RunningPluginContext } from "localhost2137";
import type { StripeConfig } from "./config.js";
import type { StripeTimeAdvance } from "./domain/models.js";
import type { StripeState } from "./state.js";

type StripeLifecycleEvent = "create" | "seed" | "start" | "stop" | `update:${number}:${number}`;

export interface StripePluginDependencies {
	readonly afterTimeReconciled?: (
		context: RunningPluginContext<StripeState, StripeConfig>,
		advance: StripeTimeAdvance,
	) => Promise<void> | void;
	readonly beforeCreate?: (context: BasePluginContext<StripeConfig>) => void;
	readonly beforeOperation?: (
		operation: string,
		context: RunningPluginContext<StripeState, StripeConfig>,
	) => void;
	readonly recordLifecycle?: (event: StripeLifecycleEvent) => void;
	readonly stateVersion?: number;
	transformOperationResult?<Value>(operation: string, value: Value): Value;
}

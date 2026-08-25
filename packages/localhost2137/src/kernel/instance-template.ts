import type { LifecycleConfigData } from "./lifecycle-context.js";
import type { ServiceLifecycleHooks } from "./service-lifecycle.js";

export interface InstanceServiceTemplate {
	readonly config: LifecycleConfigData;
	readonly configuredSeed?: unknown;
	readonly hooks: ServiceLifecycleHooks<unknown, unknown, unknown>;
	readonly pluginId: string;
	readonly serviceKey: string;
	readonly stateVersion: number;
}

export interface InstanceTemplate {
	readonly clock: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly fingerprint: string;
	readonly services: readonly InstanceServiceTemplate[];
}

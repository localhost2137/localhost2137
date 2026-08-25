import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config/config-resolution.js";
import { NodeInstanceStorage } from "./instance-storage.js";
import { nodeMonotonicClock } from "./monotonic-clock.js";
import { createProjectRuntime, type ProjectRuntimeComposition } from "./project-runtime.js";
import { NodeRuntimeTime } from "./runtime-time.js";
import { nodeTaskScheduler } from "./task-scheduler.js";

const DEV_LOG_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxEntries: 1_000 });

export interface DevProjectRuntimeOptions {
	readonly fetch?: typeof globalThis.fetch;
}

/** Supplies the production Node adapters at the daemon's single composition root. */
export function createDevProjectRuntime(
	config: ResolvedConfig,
	controlToken: string,
	options: DevProjectRuntimeOptions = {},
): ProjectRuntimeComposition {
	return createProjectRuntime(config, {
		controlToken,
		correlationId: randomUUID,
		fetch: options.fetch ?? globalThis.fetch,
		logLimits: DEV_LOG_LIMITS,
		monotonicClock: nodeMonotonicClock,
		scheduler: nodeTaskScheduler,
		storage: new NodeInstanceStorage(config.storage.dir),
		time: new NodeRuntimeTime(),
		token: randomUUID,
	});
}

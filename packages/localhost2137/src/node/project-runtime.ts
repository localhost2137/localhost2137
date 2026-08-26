import type { Hono } from "hono";
import type { ResolvedConfig } from "../config/config-resolution.js";
import { ResolvedOperationCatalog } from "../config/resolved-operation-catalog.js";
import { createScenarioSeedFactory } from "../config/scenario-seed-runtime.js";
import { createControlApi } from "../control/control-api.js";
import { ResolvedControlServiceCatalog } from "../control/control-service-catalog.js";
import { ResolvedPluginApiRegistry } from "../http/plugin-api-registry.js";
import { createPublicGateway } from "../http/public-gateway.js";
import { createRuntimeHttpApplication } from "../http/runtime-http-application.js";
import type { MonotonicClock } from "../kernel/instance-leases.js";
import { InstanceManager, type InstanceManagerDependencies } from "../kernel/instance-manager.js";
import type { InstanceStoragePort } from "../kernel/instance-storage.js";
import { OperationExecutor, OperationRunner } from "../kernel/operation-executor.js";
import type { RuntimeTime } from "../kernel/runtime-time.js";
import type { StructuredLogLimits } from "../kernel/structured-log.js";
import type { TaskScheduler } from "../kernel/task-tracker.js";
import { NodeHttpServer } from "./http-server.js";
import { createInstanceTemplate } from "./resolved-instance-template.js";
import { RuntimeServer } from "./runtime-server.js";

export interface ProjectRuntimeDependencies {
	readonly controlToken: string;
	readonly correlationId: () => string;
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	readonly logLimits: StructuredLogLimits;
	readonly monotonicClock: MonotonicClock;
	readonly scheduler: TaskScheduler;
	readonly storage: InstanceStoragePort;
	readonly time: RuntimeTime;
	readonly token: () => string;
}

export interface ProjectRuntimeComposition {
	readonly app: Hono;
	readonly instances: InstanceManager;
	readonly operations: OperationExecutor;
	readonly server: RuntimeServer;
}

/** The Node composition root; behavior remains owned by the injected components. */
export function createProjectRuntime(
	config: ResolvedConfig,
	dependencies: ProjectRuntimeDependencies,
): ProjectRuntimeComposition {
	const runner = new OperationRunner({
		time: dependencies.time,
	});
	const scenarioSeed = createScenarioSeedFactory(config, runner, dependencies.correlationId);
	const managerDependencies: InstanceManagerDependencies = {
		advanceId: dependencies.token,
		correlationId: dependencies.correlationId,
		fetch: dependencies.fetch,
		logLimits: dependencies.logLimits,
		monotonicClock: dependencies.monotonicClock,
		...(scenarioSeed ? { scenarioSeed } : {}),
		scheduler: dependencies.scheduler,
		storage: dependencies.storage,
		time: dependencies.time,
		token: dependencies.token,
	};
	const instances = new InstanceManager(createInstanceTemplate(config), managerDependencies);
	const operations = new OperationExecutor(
		instances,
		new ResolvedOperationCatalog(config),
		runner,
		dependencies.correlationId,
	);
	const control = createControlApi({
		catalog: new ResolvedControlServiceCatalog(config),
		correlationId: dependencies.correlationId,
		operations,
		runtime: instances,
		token: dependencies.controlToken,
	});
	const publicGateway = createPublicGateway({
		apis: new ResolvedPluginApiRegistry(config),
		correlationId: dependencies.correlationId,
		monotonicClock: dependencies.monotonicClock,
		runtime: instances,
		time: dependencies.time,
	});
	const app = createRuntimeHttpApplication({ control, publicGateway });
	const server = new RuntimeServer(instances, new NodeHttpServer(app));
	return Object.freeze({ app, instances, operations, server });
}

import { ownJsonValue } from "../authoring/json-value.js";
import type { CliActions, CliDevOptions, CliIo } from "../cli/cli-actions.js";
import {
	CliConfigMismatchError,
	CliRuntimeUnavailableError,
	CliTargetNotFoundError,
} from "../cli/cli-errors.js";
import { ownCliServiceDescription } from "../cli/service-description.js";
import type { ResolvedConfig } from "../config/config-resolution.js";
import { renderEnvironment } from "../config/environment-rendering.js";
import { resolveInstanceConnections } from "../config/instance-connections.js";
import { loadResolvedConfig } from "../config/load-config.js";
import type { ControlClient, ControlJsonValue } from "../control/control-client.js";
import { ControlApiError } from "../control/control-client-errors.js";
import type { RuntimeDescriptor } from "../control/runtime-descriptor.js";
import { discoverActiveRuntime, RuntimeDiscoveryError } from "./active-runtime-discovery.js";
import { runChildCommand } from "./child-command.js";
import { cloneDemoProject } from "./demo-cloner.js";
import { runDevCommand } from "./dev-command.js";
import { startDevDaemon } from "./dev-daemon.js";
import { createDevProjectRuntime } from "./dev-runtime-dependencies.js";
import { initializeProject } from "./project-initializer.js";
import { inspectProjectRuntime } from "./runtime-doctor.js";

export interface NodeCliActionsInput {
	readonly configPath?: string;
	readonly cwd: string;
	readonly fetch?: typeof globalThis.fetch;
	readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
	readonly io: CliIo;
}

export interface NodeCliActionDependencies {
	readonly discoverRuntime?: typeof discoverActiveRuntime;
	readonly inspectRuntime?: typeof inspectProjectRuntime;
	readonly loadConfig?: typeof loadResolvedConfig;
	readonly cloneDemo?: typeof cloneDemoProject;
	readonly runChild?: typeof runChildCommand;
	readonly runDev?: typeof runDevCommand;
}

interface RuntimeSession {
	readonly client: ControlClient;
	readonly config: ResolvedConfig;
	readonly descriptor: RuntimeDescriptor;
}

/** The CLI adapter delegates all mutation to the authenticated control client. */
export function createNodeCliActions(
	input: NodeCliActionsInput,
	dependencies: NodeCliActionDependencies = {},
): CliActions {
	const fetchImplementation = input.fetch ?? globalThis.fetch;
	const session = () =>
		loadRuntimeSession(input.cwd, input.configPath, fetchImplementation, dependencies);
	const forTarget = async <Value>(
		instanceId: string,
		action: (runtime: RuntimeSession) => Promise<Value>,
	): Promise<Value> => {
		const runtime = await session();
		try {
			return await action(runtime);
		} catch (cause) {
			if (!(cause instanceof ControlApiError) || cause.code !== "INSTANCE_NOT_FOUND") throw cause;
			throw await targetNotFound(runtime.client, instanceId, cause);
		}
	};

	const actions: CliActions = {
		advanceClock: (instanceId, duration) =>
			forTarget(instanceId, ({ client }) => client.clockAdvance(instanceId, duration)),
		clockStatus: (instanceId) =>
			forTarget(instanceId, ({ client }) => client.clockStatus(instanceId)),
		cloneDemo: (name, directory, install) =>
			(dependencies.cloneDemo ?? cloneDemoProject)({
				cwd: input.cwd,
				...(directory === undefined ? {} : { directory }),
				inheritedEnv: input.inheritedEnv,
				install,
				name,
			}),
		createInstance: async (id, seed) => {
			const runtime = await session();
			return await runtime.client.createInstance({ id, persistence: "persistent", seed });
		},
		describe: (instanceId, serviceKey) =>
			forTarget(instanceId, async ({ client }) =>
				serviceKey === undefined
					? await client.listServices(instanceId)
					: describeForCli(await client.describeService(instanceId, serviceKey)),
			),
		describeService: (instanceId, serviceKey) =>
			forTarget(instanceId, async ({ client }) =>
				ownCliServiceDescription(await client.describeService(instanceId, serviceKey)),
			),
		destroyInstance: async (id) => {
			await forTarget(id, ({ client }) => client.destroyInstance(id));
		},
		dev: (options) => runDev(input, options, fetchImplementation, dependencies),
		doctor: () =>
			(dependencies.inspectRuntime ?? inspectProjectRuntime)({
				...(input.configPath === undefined ? {} : { configPath: input.configPath }),
				cwd: input.cwd,
				...(input.fetch ? { fetch: input.fetch } : {}),
			}),
		environment: (instanceId, format) =>
			forTarget(instanceId, async (runtime) => {
				await runtime.client.getInstance(instanceId);
				return renderEnvironment(instanceConnections(runtime, instanceId).env, format);
			}),
		execute: ({ input: operationInput, instanceId, operationKey, serviceKey }) =>
			forTarget(instanceId, ({ client }) =>
				client.executeOperation(instanceId, serviceKey, operationKey, ownJsonValue(operationInput)),
			),
		initProject: () => initializeProject(input.cwd),
		listInstances: async () => (await session()).client.listInstances(),
		logs: ({ instanceId, serviceKey, tail }) =>
			forTarget(instanceId, ({ client }) =>
				client.logs(instanceId, {
					...(serviceKey === undefined ? {} : { service: serviceKey }),
					tail,
				}),
			),
		resetInstance: (id, seed) => forTarget(id, ({ client }) => client.resetInstance(id, { seed })),
		run: (instanceId, command) =>
			forTarget(instanceId, async (runtime) => {
				await runtime.client.getInstance(instanceId);
				return await (dependencies.runChild ?? runChildCommand)({
					argv: command,
					connectionEnv: instanceConnections(runtime, instanceId).env,
					cwd: input.cwd,
					inheritedEnv: input.inheritedEnv,
				});
			}),
		seed: async (instanceId) => {
			await forTarget(instanceId, ({ client }) => client.seedInstance(instanceId));
		},
	};
	return Object.freeze(actions);
}

function describeForCli(value: ControlJsonValue): unknown {
	const service = ownCliServiceDescription(value);
	return Object.freeze({
		description: service.description,
		name: service.name,
		operations: service.operationMetadata,
	});
}

async function loadRuntimeSession(
	cwd: string,
	configPath: string | undefined,
	fetch: typeof globalThis.fetch,
	dependencies: NodeCliActionDependencies,
): Promise<RuntimeSession> {
	const config = await (dependencies.loadConfig ?? loadResolvedConfig)({
		cwd,
		...(configPath === undefined ? {} : { explicitPath: configPath }),
	});
	let active: Awaited<ReturnType<typeof discoverActiveRuntime>>;
	try {
		active = await (dependencies.discoverRuntime ?? discoverActiveRuntime)(config.storage.dir, {
			fetch,
		});
	} catch (cause) {
		if (cause instanceof RuntimeDiscoveryError) {
			throw new CliRuntimeUnavailableError(cause.message, cause);
		}
		throw cause;
	}
	if (active.descriptor.configFingerprint !== config.fingerprint) {
		throw new CliConfigMismatchError();
	}
	return Object.freeze({ client: active.client, config, descriptor: active.descriptor });
}

function instanceConnections(
	runtime: RuntimeSession,
	instanceId: string,
): ReturnType<typeof resolveInstanceConnections> {
	return resolveInstanceConnections(runtime.config, {
		baseUrl: runtime.descriptor.url,
		instanceId,
	});
}

async function targetNotFound(
	client: ControlClient,
	instanceId: string,
	cause: ControlApiError,
): Promise<CliTargetNotFoundError> {
	let existing: readonly string[] = [];
	try {
		existing = instanceIds(await client.listInstances());
	} catch {
		// The original target error remains the authoritative failure.
	}
	return new CliTargetNotFoundError(instanceId, existing, cause);
}

function instanceIds(value: ControlJsonValue): readonly string[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	return Object.freeze(
		value.flatMap((entry) =>
			isJsonObject(entry) && typeof entry.id === "string" ? [entry.id] : [],
		),
	);
}

function isJsonObject(
	value: ControlJsonValue,
): value is Readonly<Record<string, ControlJsonValue>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runDev(
	input: NodeCliActionsInput,
	options: CliDevOptions,
	fetch: typeof globalThis.fetch,
	dependencies: NodeCliActionDependencies,
): Promise<void> {
	await (dependencies.runDev ?? runDevCommand)(
		{
			...(input.configPath === undefined ? {} : { configPath: input.configPath }),
			cwd: input.cwd,
			io: input.io,
			options,
		},
		{
			startDaemon: (daemonOptions) =>
				startDevDaemon(daemonOptions, {
					createRuntime: (config, token) => createDevProjectRuntime(config, token, { fetch }),
				}),
		},
	);
}

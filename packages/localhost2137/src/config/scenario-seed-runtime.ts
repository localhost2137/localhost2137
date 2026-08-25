import type { RuntimeOperationDefinition } from "../authoring/plugin.js";
import type { ScenarioSeedFactoryInput } from "../kernel/active-instance.js";
import type { ScenarioSeedPort } from "../kernel/instance-lifecycle.js";
import type { OperationRunner } from "../kernel/operation-executor.js";
import { type OperationJsonObject, ownOperationJson } from "../kernel/operation-json.js";
import type { AnyServiceLifecycle } from "../kernel/service-lifecycle.js";
import type { ResolvedConfig } from "./config-resolution.js";
import type { ResolvedServiceConfig } from "./configured-service-resolution.js";

type RuntimeScenario = Readonly<Record<string, RuntimeScenarioService>>;
type RuntimeScenarioService = Readonly<Record<string, unknown>>;

/** Builds the lease-scoped facade used only while InstanceLifecycle owns exclusivity. */
export function createScenarioSeedFactory(
	config: ResolvedConfig,
	runner: OperationRunner,
): ((input: ScenarioSeedFactoryInput) => ScenarioSeedPort | undefined) | undefined {
	const seed = config.seed;
	if (!seed) return undefined;
	return (input) => ({
		run: async (signal) => {
			const facade = createScenarioFacade(config, runner, input, signal);
			await Reflect.apply(seed, undefined, [facade]);
		},
	});
}

function createScenarioFacade(
	config: ResolvedConfig,
	runner: OperationRunner,
	input: ScenarioSeedFactoryInput,
	signal: AbortSignal,
): RuntimeScenario {
	const facade: Record<string, RuntimeScenarioService> = Object.create(null);
	for (const [serviceKey, configuredService] of Object.entries(config.services)) {
		const lifecycle = findService(input.services, serviceKey);
		const service: Record<string, unknown> = Object.create(null);
		defineEntry(
			service,
			"connection",
			instanceConnection(config, configuredService, input.instanceId),
		);
		for (const [operationKey, operation] of Object.entries(configuredService.plugin.operations)) {
			defineEntry(service, operationKey, (rawInput: unknown) =>
				runScopedOperation({
					input,
					lifecycle,
					operation,
					operationKey,
					rawInput,
					runner,
					serviceKey,
					signal,
				}),
			);
		}
		defineEntry(facade, serviceKey, Object.freeze(service));
	}
	return Object.freeze(facade);
}

async function runScopedOperation(
	input: Readonly<{
		input: ScenarioSeedFactoryInput;
		lifecycle: AnyServiceLifecycle;
		operation: RuntimeOperationDefinition;
		operationKey: string;
		rawInput: unknown;
		runner: OperationRunner;
		serviceKey: string;
		signal: AbortSignal;
	}>,
): Promise<unknown> {
	return await input.runner.run({
		context: input.lifecycle.runningContext(input.signal),
		instanceId: input.input.instanceId,
		logs: input.input.logs,
		operation: input.operation,
		operationKey: input.operationKey,
		rawInput: input.rawInput,
		serviceKey: input.serviceKey,
		signal: input.signal,
	});
}

function instanceConnection(
	config: ResolvedConfig,
	service: ResolvedServiceConfig,
	instanceId: string,
): OperationJsonObject {
	const connection = service.plugin.connection;
	if (typeof connection !== "function") {
		throw new TypeError(
			`Validated connection for service "${service.serviceKey}" is not callable.`,
		);
	}
	const value = Reflect.apply(connection, undefined, [
		{
			baseUrl: formatBaseUrl(config.host, config.port),
			config: service.config,
			instanceId,
			serviceKey: service.serviceKey,
		},
	]);
	const values = isRecord(value) ? value.values : undefined;
	const owned = ownOperationJson(values);
	if (!isOperationJsonObject(owned)) {
		throw new TypeError(`Connection values for service "${service.serviceKey}" must be an object.`);
	}
	return owned;
}

function isOperationJsonObject(value: unknown): value is OperationJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findService(
	services: readonly AnyServiceLifecycle[],
	serviceKey: string,
): AnyServiceLifecycle {
	const service = services.find((candidate) => candidate.serviceKey === serviceKey);
	if (!service)
		throw new TypeError(`Running service "${serviceKey}" is missing from the instance.`);
	return service;
}

function defineEntry(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}

function formatBaseUrl(host: ResolvedConfig["host"], port: number): string {
	return `http://${host === "::1" ? `[${host}]` : host}:${port}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

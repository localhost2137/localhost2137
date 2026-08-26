import type { BasePluginContext, RunningPluginContext } from "../authoring/context.js";
import type { ResolvedConfig } from "../config/config-resolution.js";
import type { ResolvedServiceConfig } from "../config/configured-service-resolution.js";
import type { InstanceServiceTemplate, InstanceTemplate } from "../kernel/instance-template.js";
import type { ServiceLifecycleHooks } from "../kernel/service-lifecycle.js";
import type { PluginTimeAdvanceInput } from "../kernel/time-advance.js";

export function createInstanceTemplate(config: ResolvedConfig): InstanceTemplate {
	return Object.freeze({
		clock: config.clock,
		fingerprint: config.fingerprint,
		services: Object.freeze(
			Object.values(config.services).map((service) => createServiceTemplate(service)),
		),
	});
}

function createServiceTemplate(service: ResolvedServiceConfig): InstanceServiceTemplate {
	const lifecycle = service.plugin.lifecycle;
	const create = requiredHook(lifecycle, "create");
	const start = requiredHook(lifecycle, "start");
	const seed = optionalHook(lifecycle, "seed");
	const onTimeAdvanced = optionalHook(lifecycle, "onTimeAdvanced");
	const stop = optionalHook(lifecycle, "stop");
	const update = optionalHook(lifecycle, "update");
	const hooks: ServiceLifecycleHooks<unknown, unknown, unknown> = Object.freeze({
		create: async (context: BasePluginContext<unknown>) => {
			await invoke(create, [context]);
		},
		...(onTimeAdvanced
			? {
					onTimeAdvanced: async (
						context: RunningPluginContext<unknown, unknown>,
						advance: PluginTimeAdvanceInput,
					) => {
						await invoke(onTimeAdvanced, [context, advance]);
					},
				}
			: {}),
		...(seed
			? {
					seed: async (context: RunningPluginContext<unknown, unknown>, value: unknown) => {
						await invoke(seed, [context, value]);
					},
				}
			: {}),
		start: async (context: BasePluginContext<unknown>) => invoke(start, [context]),
		...(stop
			? {
					stop: async (context: RunningPluginContext<unknown, unknown>) => {
						await invoke(stop, [context]);
					},
				}
			: {}),
		...(update
			? {
					update: async (
						context: BasePluginContext<unknown>,
						version: Readonly<{ from: number; to: number }>,
					) => {
						await invoke(update, [context, version]);
					},
				}
			: {}),
	});
	return Object.freeze({
		config: service.config,
		...(service.seed === undefined ? {} : { configuredSeed: service.seed }),
		hooks,
		pluginId: service.pluginId,
		serviceKey: service.serviceKey,
		stateVersion: service.stateVersion,
	});
}

type RuntimeHook = (...arguments_: never[]) => unknown;

function requiredHook(lifecycle: object, name: string): RuntimeHook {
	const hook = Reflect.get(lifecycle, name);
	if (!isRuntimeHook(hook)) throw new TypeError(`Validated lifecycle.${name} is not callable.`);
	return hook;
}

function optionalHook(lifecycle: object, name: string): RuntimeHook | undefined {
	const hook = Reflect.get(lifecycle, name);
	if (hook === undefined) return undefined;
	if (!isRuntimeHook(hook)) throw new TypeError(`Validated lifecycle.${name} is not callable.`);
	return hook;
}

async function invoke(hook: RuntimeHook, arguments_: readonly unknown[]): Promise<unknown> {
	return await Reflect.apply(hook, undefined, arguments_);
}

function isRuntimeHook(value: unknown): value is RuntimeHook {
	return typeof value === "function";
}

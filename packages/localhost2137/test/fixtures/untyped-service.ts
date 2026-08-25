import { Hono } from "hono";
import { z } from "zod";

const configuredServiceSymbol = Symbol.for("localhost2137.configuredServiceRuntime.v1");

export interface UntypedServiceOptions {
	readonly configSchema?: unknown;
	readonly connection?: unknown;
	readonly input?: unknown;
	readonly lifecycle?: Readonly<Record<string, unknown>>;
	readonly seedSchema?: unknown;
}

/** Build the value JavaScript can provide after bypassing authoring types. */
export function untypedConfiguredService(options: UntypedServiceOptions = {}): object {
	const operation = {
		description: "Untyped operation",
		input: options.input ?? z.object({ name: z.string() }),
		output: z.object({ ok: z.boolean() }),
		run: () => ({ ok: true }),
	};
	const definition = {
		api: new Hono(),
		configSchema: options.configSchema ?? z.object({ token: z.string() }),
		connection: options.connection ?? (() => ({ env: {}, values: {} })),
		description: "Untyped JavaScript fixture",
		id: "untyped",
		lifecycle: {
			create: () => undefined,
			start: () => ({ ready: true }),
			...options.lifecycle,
		},
		operations: { operate: operation },
		...(options.seedSchema === undefined ? {} : { seedSchema: options.seedSchema }),
		stateVersion: 1,
	};
	const descriptor = {};
	Object.defineProperty(descriptor, configuredServiceSymbol, {
		configurable: false,
		enumerable: false,
		value: Object.freeze({
			definition: Object.freeze(definition),
			envelope: { config: { token: "x" } },
		}),
		writable: false,
	});
	return descriptor;
}

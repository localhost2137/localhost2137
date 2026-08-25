import type { z } from "zod";
import type { RunningPluginContext } from "./context.js";

type ObjectSchema = z.ZodObject;
export type Schema = z.ZodType;

declare const operationBindingType: unique symbol;
const operationRuntimeType: unique symbol = Symbol.for("localhost2137.operationRuntime.v1");

interface OperationBinding {
	readonly token: object;
}

export interface OperationShape {
	readonly description: string;
	readonly input: ObjectSchema;
	readonly output: Schema;
}

export interface BoundOperationShape<PluginId extends string, State, Config>
	extends OperationShape {
	readonly [operationBindingType]: (
		pluginId: PluginId,
		state: State,
		config: Config,
	) => readonly [pluginId: PluginId, state: State, config: Config];
}

export interface OperationDefinitionInput<
	State,
	Config,
	InputSchema extends ObjectSchema,
	OutputSchema extends Schema,
> {
	readonly description: string;
	readonly input: InputSchema;
	readonly output: OutputSchema;
	run(
		context: RunningPluginContext<State, Config>,
		input: z.output<InputSchema>,
	): Promise<z.input<OutputSchema>> | z.input<OutputSchema>;
}

export type OperationDefinition<
	PluginId extends string,
	State,
	Config,
	InputSchema extends ObjectSchema,
	OutputSchema extends Schema,
> = OperationDefinitionInput<State, Config, InputSchema, OutputSchema> &
	BoundOperationShape<PluginId, State, Config>;

export type BoundOperationDefinition<PluginId extends string, State, Config> = <
	const InputSchema extends ObjectSchema,
	const OutputSchema extends Schema,
>(
	definition: OperationDefinitionInput<State, Config, InputSchema, OutputSchema>,
) => OperationDefinition<PluginId, State, Config, InputSchema, OutputSchema>;

/** Create one literal-ID and context-bound operation helper per plugin module. */
export function defineOperation<
	const PluginId extends string,
	State,
	Config,
>(): BoundOperationDefinition<PluginId, State, Config> {
	const token = Object.freeze({});

	return <const InputSchema extends ObjectSchema, const OutputSchema extends Schema>(
		definition: OperationDefinitionInput<State, Config, InputSchema, OutputSchema>,
	): OperationDefinition<PluginId, State, Config, InputSchema, OutputSchema> => {
		const descriptor = { ...definition };
		Object.defineProperty(descriptor, operationRuntimeType, {
			configurable: false,
			enumerable: false,
			value: Object.freeze({ token }),
			writable: false,
		});

		// TypeScript cannot express adding a unique-symbol phantom to a generic
		// object via defineProperty. This is the sole authoring construction cast;
		// readOperationBinding verifies the corresponding runtime value.
		return Object.freeze(descriptor) as OperationDefinition<
			PluginId,
			State,
			Config,
			InputSchema,
			OutputSchema
		>;
	};
}

export function readOperationBinding(operation: unknown): OperationBinding | undefined {
	if (!isObject(operation) || !(operationRuntimeType in operation)) {
		return undefined;
	}

	const binding = operation[operationRuntimeType];
	return isOperationBinding(binding) ? binding : undefined;
}

function isObject(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null;
}

function isOperationBinding(value: unknown): value is OperationBinding {
	return isObject(value) && typeof value.token === "object" && value.token !== null;
}

import type { RunningPluginContext } from "../authoring/context.js";
import { LocalhostError, withCorrelation } from "../authoring/localhost-error.js";
import type { RuntimeOperationDefinition } from "../authoring/plugin.js";
import { type OperationJsonValue, ownOperationJson } from "./operation-json.js";
import type { RuntimeTime } from "./runtime-time.js";
import type { StructuredLogRing } from "./structured-log.js";

export interface OperationDescriptorResolver {
	resolve(serviceKey: string, operationKey: string): RuntimeOperationDefinition | undefined;
}

interface OperationServiceLease {
	readonly context: RunningPluginContext<unknown, unknown>;
	readonly generation: object;
	readonly logs: StructuredLogRing;
	release(): void;
}

export interface OperationRuntimeAccess {
	acquireService(
		instanceId: string,
		serviceKey: string,
		signal?: AbortSignal,
	): Promise<OperationServiceLease>;
}

export interface ScopedOperationInput {
	readonly correlationId: string;
	readonly context: RunningPluginContext<unknown, unknown>;
	readonly instanceId: string;
	readonly logs: StructuredLogRing;
	readonly operation: RuntimeOperationDefinition;
	readonly operationKey: string;
	readonly rawInput: unknown;
	readonly serviceKey: string;
	readonly signal?: AbortSignal;
}

export class OperationNotFoundError extends LocalhostError {
	constructor(serviceKey: string, operationKey: string) {
		super(
			"OPERATION_NOT_FOUND",
			`Operation "${operationKey}" is not defined by service "${serviceKey}".`,
			{ status: 404 },
		);
		this.name = "OperationNotFoundError";
	}
}

/** Owns operation validation, invocation, result ownership, and observability. */
export class OperationRunner {
	readonly #time: RuntimeTime;

	constructor(dependencies: Readonly<{ time: RuntimeTime }>) {
		this.#time = dependencies.time;
	}

	async run(input: ScopedOperationInput): Promise<OperationJsonValue> {
		const correlationId = input.correlationId;
		const startedAt = this.#time.nowMilliseconds();
		appendOperationLog(input, {
			correlationId,
			message: `Operation ${input.operationKey} started.`,
			status: "started",
			wallTime: this.#time.nowTimestamp(),
		});

		try {
			const parsedInput = await input.operation.input.safeParseAsync(input.rawInput);
			if (!parsedInput.success) {
				throw new LocalhostError(
					"INVALID_OPERATION_INPUT",
					`Input validation failed for operation "${input.operationKey}".`,
					{
						correlationId,
						details: Object.freeze({ issues: validationIssues(parsedInput.error.issues) }),
						status: 400,
					},
				);
			}
			input.signal?.throwIfAborted();
			const context = executionContext(input.context, input.signal);
			const rawOutput = await invokeOperation(input.operation.run, context, parsedInput.data);
			input.signal?.throwIfAborted();
			const parsedOutput = await input.operation.output.safeParseAsync(rawOutput);
			if (!parsedOutput.success) {
				throw new LocalhostError(
					"OPERATION_OUTPUT_INVALID",
					`Operation "${input.operationKey}" returned an invalid result.`,
					{
						cause: parsedOutput.error,
						correlationId,
						status: 500,
					},
				);
			}
			let data: OperationJsonValue;
			try {
				data = ownOperationJson(parsedOutput.data);
			} catch (cause) {
				throw new LocalhostError(
					"OPERATION_OUTPUT_INVALID",
					`Operation "${input.operationKey}" returned a non-JSON result.`,
					{ cause, correlationId, status: 500 },
				);
			}
			appendOperationLog(input, {
				correlationId,
				durationMs: duration(this.#time.nowMilliseconds(), startedAt),
				message: `Operation ${input.operationKey} succeeded.`,
				status: "succeeded",
				wallTime: this.#time.nowTimestamp(),
			});
			return data;
		} catch (cause) {
			const error = operationError(cause, correlationId, input.signal);
			appendOperationLog(input, {
				attributes: Object.freeze({ code: error.code, internalCause: cause }),
				correlationId,
				durationMs: duration(this.#time.nowMilliseconds(), startedAt),
				message: `Operation ${input.operationKey} failed.`,
				status: "failed",
				wallTime: this.#time.nowTimestamp(),
			});
			throw error;
		}
	}
}

/** Adds shared-running lease acquisition around the common operation runner. */
export class OperationExecutor {
	readonly #access: OperationRuntimeAccess;
	readonly #correlationId: () => string;
	readonly #operations: OperationDescriptorResolver;
	readonly #runner: OperationRunner;

	constructor(
		access: OperationRuntimeAccess,
		operations: OperationDescriptorResolver,
		runner: OperationRunner,
		correlationId: () => string,
	) {
		this.#access = access;
		this.#correlationId = correlationId;
		this.#operations = operations;
		this.#runner = runner;
	}

	async execute(
		input: Readonly<{
			correlationId?: string;
			instanceId: string;
			operationKey: string;
			rawInput: unknown;
			serviceKey: string;
			signal?: AbortSignal;
		}>,
	): Promise<OperationJsonValue> {
		const correlationId = input.correlationId ?? this.#correlationId();
		const operation = this.#operations.resolve(input.serviceKey, input.operationKey);
		if (!operation) throw new OperationNotFoundError(input.serviceKey, input.operationKey);
		const lease = await this.#access.acquireService(
			input.instanceId,
			input.serviceKey,
			input.signal,
		);
		try {
			return await this.#runner.run({
				...input,
				correlationId,
				context: lease.context,
				logs: lease.logs,
				operation,
			});
		} finally {
			lease.release();
		}
	}
}

function executionContext(
	context: RunningPluginContext<unknown, unknown>,
	signal: AbortSignal | undefined,
): RunningPluginContext<unknown, unknown> {
	if (!signal || signal === context.signal) return context;
	return Object.freeze({ ...context, signal: AbortSignal.any([context.signal, signal]) });
}

function invokeOperation(
	run: unknown,
	context: RunningPluginContext<unknown, unknown>,
	input: unknown,
): Promise<unknown> {
	if (typeof run !== "function") throw new TypeError("Validated operation.run is not callable.");
	return Promise.resolve(Reflect.apply(run, undefined, [context, input]));
}

function operationError(
	cause: unknown,
	correlationId: string,
	signal: AbortSignal | undefined,
): LocalhostError {
	if (cause instanceof LocalhostError) {
		try {
			return withCorrelation(cause, correlationId);
		} catch {
			// An untyped plugin can forge or corrupt a prototype-compatible value.
			// Treat it as an unknown plugin failure instead of trusting its fields.
		}
	}
	if (signal?.aborted && cause === signal.reason) {
		return new LocalhostError("REQUEST_ABORTED", "Operation execution was cancelled.", {
			cause,
			correlationId,
			status: 499,
		});
	}
	return new LocalhostError("PLUGIN_EXECUTION_FAILED", "The plugin operation failed.", {
		cause,
		correlationId,
		status: 500,
	});
}

function validationIssues(
	issues: readonly Readonly<{ code: string; message: string; path: readonly PropertyKey[] }>[],
): readonly Readonly<{ code: string; message: string; path: readonly PropertyKey[] }>[] {
	return Object.freeze(
		issues.map((issue) =>
			Object.freeze({
				code: issue.code,
				message: issue.message,
				path: Object.freeze([...issue.path]),
			}),
		),
	);
}

function duration(finishedAt: number, startedAt: number): number {
	return Math.max(0, finishedAt - startedAt);
}

function appendOperationLog(
	input: ScopedOperationInput,
	entry: Readonly<{
		attributes?: Readonly<Record<string, unknown>>;
		correlationId: string;
		durationMs?: number;
		message: string;
		status: "failed" | "started" | "succeeded";
		wallTime: string;
	}>,
): void {
	input.logs.append({
		...(entry.attributes ? { attributes: entry.attributes } : {}),
		correlationId: entry.correlationId,
		...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
		instanceId: input.instanceId,
		kind: "operation",
		message: entry.message,
		serviceKey: input.serviceKey,
		status: entry.status,
		virtualTime: input.context.clock.now().toISOString(),
		wallTime: entry.wallTime,
	});
}

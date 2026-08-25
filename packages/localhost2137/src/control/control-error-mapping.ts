import { LocalhostError, withCorrelation } from "../authoring/localhost-error.js";
import {
	InstanceAlreadyExistsError,
	InstanceNotFoundError,
} from "../kernel/active-instance-registry.js";
import { InstanceMutationCommittedError } from "../kernel/durable-instance-mutations.js";
import { InvalidIdentifierError } from "../kernel/identifiers.js";
import {
	LeaseAbortedError,
	LeaseRetiredError,
	LeaseTimeoutError,
} from "../kernel/instance-leases.js";
import { SeedNotAllowedError } from "../kernel/instance-lifecycle.js";
import { ServiceNotFoundError } from "../kernel/instance-manager.js";
import { InvalidLifecycleTransitionError } from "../kernel/lifecycle-state.js";
import { MutationAbortedError, MutationTimeoutError } from "../kernel/mutation-scope.js";
import { ownOperationJson } from "../kernel/operation-json.js";
import { InstanceRuntimeClosedError } from "../kernel/persisted-instance-runtime.js";
import { redact, redactText } from "../kernel/redaction.js";
import {
	TaskIdleAbortedError,
	TaskIdleTimeoutError,
	TrackedTaskFailuresError,
} from "../kernel/task-tracker.js";

export interface ControlErrorEnvelope {
	readonly error: Readonly<{
		readonly code: string;
		readonly correlationId: string;
		readonly details?: Readonly<Record<string, unknown>>;
		readonly message: string;
	}>;
}

export function mapControlError(cause: unknown, correlationId: string): LocalhostError {
	if (cause instanceof LocalhostError) {
		try {
			return safeLocalhostError(cause, correlationId);
		} catch {
			return error(
				"INTERNAL_ERROR",
				"The runtime could not complete the request.",
				500,
				correlationId,
			);
		}
	}
	if (cause instanceof InvalidIdentifierError) {
		return error("INVALID_REQUEST", "Invalid instance or service identifier.", 400, correlationId);
	}
	if (cause instanceof InstanceNotFoundError) {
		return error("INSTANCE_NOT_FOUND", "Instance not found.", 404, correlationId);
	}
	if (cause instanceof ServiceNotFoundError) {
		return error("SERVICE_NOT_FOUND", "Service not found.", 404, correlationId);
	}
	if (cause instanceof InstanceAlreadyExistsError) {
		return error(
			"INSTANCE_CONFLICT",
			"An instance with that identifier already exists.",
			409,
			correlationId,
		);
	}
	if (cause instanceof SeedNotAllowedError || cause instanceof InvalidLifecycleTransitionError) {
		return error(
			"LIFECYCLE_CONFLICT",
			"The instance lifecycle does not allow this action.",
			409,
			correlationId,
		);
	}
	if (cause instanceof TaskIdleTimeoutError || cause instanceof LeaseTimeoutError) {
		return error(
			"IDLE_TIMEOUT",
			"Timed out waiting for the instance to become idle.",
			408,
			correlationId,
		);
	}
	if (
		cause instanceof MutationAbortedError ||
		cause instanceof LeaseAbortedError ||
		cause instanceof TaskIdleAbortedError
	) {
		return error("REQUEST_ABORTED", "The control request was cancelled.", 499, correlationId);
	}
	if (cause instanceof MutationTimeoutError) {
		return error("LIFECYCLE_CONFLICT", "The lifecycle action timed out.", 503, correlationId, true);
	}
	if (cause instanceof LeaseRetiredError || cause instanceof InstanceRuntimeClosedError) {
		return error(
			"LIFECYCLE_CONFLICT",
			"The runtime is closing or changing generation.",
			503,
			correlationId,
			true,
		);
	}
	if (cause instanceof InstanceMutationCommittedError) {
		return error(
			"INSTANCE_MUTATION_COMMITTED",
			"The instance mutation committed but finalization did not complete cleanly.",
			500,
			correlationId,
		);
	}
	if (cause instanceof TrackedTaskFailuresError) {
		return error("PLUGIN_EXECUTION_FAILED", "Tracked plugin work failed.", 500, correlationId);
	}
	return error("INTERNAL_ERROR", "The runtime could not complete the request.", 500, correlationId);
}

export function controlErrorEnvelope(error: LocalhostError): ControlErrorEnvelope {
	if (!error.correlationId) throw new TypeError("Control errors require a correlation ID.");
	return Object.freeze({
		error: Object.freeze({
			code: error.code,
			correlationId: error.correlationId,
			...(error.details ? { details: error.details } : {}),
			message: error.message,
		}),
	});
}

function safeLocalhostError(cause: LocalhostError, correlationId: string): LocalhostError {
	const correlated = withCorrelation(cause, correlationId);
	const details = safeDetails(correlated.details);
	const status = validErrorStatus(correlated.status) ? correlated.status : 500;
	return new LocalhostError(correlated.code, redactText(correlated.message), {
		cause: correlated,
		correlationId,
		...(details ? { details } : {}),
		retryable: correlated.retryable,
		status,
	});
}

function safeDetails(
	details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (!details) return undefined;
	try {
		const value = ownOperationJson(redact(details));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(
	code: string,
	message: string,
	status: number,
	correlationId: string,
	retryable: boolean = false,
): LocalhostError {
	return new LocalhostError(code, message, { correlationId, retryable, status });
}

function validErrorStatus(status: number): boolean {
	return Number.isSafeInteger(status) && status >= 400 && status <= 599;
}

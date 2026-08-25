import { ConfigError } from "../config/config-error.js";
import {
	ControlApiError,
	ControlProtocolError,
	ControlTransportError,
} from "../control/control-client-errors.js";

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export class CliConfigMismatchError extends Error {
	constructor() {
		super(
			"The active runtime configuration differs from the current resolved config; restart `localhost dev`.",
		);
		this.name = "CliConfigMismatchError";
	}
}

export class CliRuntimeUnavailableError extends Error {
	declare readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(`${message}\nRun \`localhost dev\` to start the project runtime.`);
		this.name = "CliRuntimeUnavailableError";
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

export class CliTargetNotFoundError extends Error {
	declare readonly cause: unknown;
	readonly instanceId: string;

	constructor(instanceId: string, existing: readonly string[], cause: unknown) {
		const available = existing.length === 0 ? "none" : existing.join(", ");
		super(
			`no instance ${JSON.stringify(instanceId)} (existing: ${available})\nhint: localhost instance create ${instanceId}`,
		);
		this.name = "CliTargetNotFoundError";
		this.instanceId = instanceId;
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

export interface CliFailure {
	readonly exitCode: 2 | 3 | 4 | 5 | 10 | 130;
	readonly message: string;
}

export function classifyCliFailure(cause: unknown): CliFailure {
	if (cause instanceof CliUsageError) return failure(2, cause.message);
	if (cause instanceof CliTargetNotFoundError) return failure(4, cause.message);
	if (cause instanceof CliConfigMismatchError || cause instanceof CliRuntimeUnavailableError) {
		return failure(3, cause.message);
	}
	if (cause instanceof ControlApiError) return classifyApiFailure(cause);
	if (
		cause instanceof ControlProtocolError ||
		cause instanceof ControlTransportError ||
		cause instanceof ConfigError ||
		isRuntimeDiscoveryFailure(cause)
	) {
		return failure(3, cause.message);
	}
	if (isInterruption(cause)) return failure(130, "Interrupted.");
	return failure(10, safeUnknownMessage(cause));
}

function classifyApiFailure(cause: ControlApiError): CliFailure {
	const suffix = ` (correlation ${cause.correlationId})`;
	if (cause.code === "REQUEST_ABORTED") return failure(130, `Interrupted${suffix}.`);
	if (cause.code === "INVALID_OPERATION_INPUT" || cause.code === "INVALID_REQUEST") {
		return failure(2, `${cause.message}${suffix}`);
	}
	if (
		cause.code === "INSTANCE_NOT_FOUND" ||
		cause.code === "OPERATION_NOT_FOUND" ||
		cause.code === "SERVICE_NOT_FOUND"
	) {
		return failure(4, `${cause.message}${suffix}`);
	}
	if (
		cause.code === "IDLE_TIMEOUT" ||
		cause.code === "INSTANCE_CONFLICT" ||
		cause.code === "INSTANCE_MUTATION_COMMITTED" ||
		cause.code === "LIFECYCLE_CONFLICT"
	) {
		return failure(5, `${cause.message}${suffix}`);
	}
	if (cause.code === "AUTHENTICATION_REQUIRED" || cause.code === "BROWSER_ORIGIN_REJECTED") {
		return failure(3, `${cause.message}${suffix}`);
	}
	return failure(10, `${cause.message}${suffix}`);
}

function isRuntimeDiscoveryFailure(value: unknown): value is Error {
	return (
		value instanceof Error &&
		[
			"ActiveRuntimeDiscoveryError",
			"ActiveRuntimeFileError",
			"DevDaemonFatalError",
			"RuntimeDiscoveryError",
			"RuntimeDescriptorValidationError",
		].includes(value.name)
	);
}

function isInterruption(value: unknown): boolean {
	return (
		(value instanceof DOMException && value.name === "AbortError") ||
		(value instanceof Error && (value.name === "AbortError" || value.name === "SignalInterruption"))
	);
}

function safeUnknownMessage(value: unknown): string {
	if (value instanceof Error && value.message.trim() !== "") return value.message;
	return "The localhost2137 command failed.";
}

function failure(exitCode: CliFailure["exitCode"], message: string): CliFailure {
	return Object.freeze({ exitCode, message });
}

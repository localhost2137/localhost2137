export type ControlClientFailureKind = "api" | "protocol" | "transport";

export class ControlApiError extends Error {
	readonly code: string;
	readonly correlationId: string;
	readonly details?: Readonly<Record<string, ControlJsonValue>>;
	readonly kind: "api" = "api";
	readonly status: number;

	constructor(input: {
		readonly code: string;
		readonly correlationId: string;
		readonly details?: Readonly<Record<string, ControlJsonValue>>;
		readonly message: string;
		readonly status: number;
	}) {
		super(input.message);
		this.name = "ControlApiError";
		this.code = input.code;
		this.correlationId = input.correlationId;
		if (input.details) this.details = input.details;
		this.status = input.status;
	}
}

export class ControlProtocolError extends Error {
	readonly kind: "protocol" = "protocol";
	readonly status?: number;

	constructor(message: string, options: Readonly<{ cause?: unknown; status?: number }> = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ControlProtocolError";
		if (options.status !== undefined) this.status = options.status;
	}
}

export class ControlTransportError extends Error {
	readonly aborted: boolean;
	readonly kind: "transport" = "transport";

	constructor(cause: unknown, aborted: boolean) {
		super(
			aborted
				? "The localhost2137 control request was cancelled."
				: "Could not reach the localhost2137 runtime.",
			{ cause },
		);
		this.name = "ControlTransportError";
		this.aborted = aborted;
	}
}

export type ControlJsonPrimitive = boolean | number | string | null;
export interface ControlJsonArray extends ReadonlyArray<ControlJsonValue> {}
export interface ControlJsonObject {
	readonly [key: string]: ControlJsonValue;
}
export type ControlJsonValue = ControlJsonPrimitive | ControlJsonArray | ControlJsonObject;

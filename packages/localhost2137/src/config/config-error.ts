export type ConfigErrorCode =
	| "CONFIG_DEFAULT_EXPORT_MISSING"
	| "CONFIG_IMPORT_FAILED"
	| "CONFIG_INVALID"
	| "CONFIG_NOT_FOUND";

export interface ConfigIssue {
	readonly code: string;
	readonly expected?: string;
	readonly message: string;
	readonly path: string;
	readonly received?: string;
	readonly serviceKey?: string;
}

export interface ConfigErrorDetails {
	readonly configPath?: string;
	readonly issues?: readonly ConfigIssue[];
	readonly searchedFrom?: string;
}

export class ConfigError extends Error {
	readonly code: ConfigErrorCode;
	override readonly cause: unknown;
	readonly details: ConfigErrorDetails;

	constructor(
		code: ConfigErrorCode,
		message: string,
		details: ConfigErrorDetails = {},
		cause?: unknown,
	) {
		super(message);
		this.name = "ConfigError";
		this.code = code;
		this.cause = cause;
		this.details = Object.freeze({
			...details,
			...(details.issues
				? { issues: Object.freeze(details.issues.map((issue) => Object.freeze({ ...issue }))) }
				: {}),
		});
	}

	toJSON(): Readonly<{
		code: ConfigErrorCode;
		details: ConfigErrorDetails;
		message: string;
	}> {
		return Object.freeze({ code: this.code, details: this.details, message: this.message });
	}
}

export function issuePath(path: readonly PropertyKey[]): string {
	if (path.length === 0) {
		return "$";
	}
	return path.reduce<string>((result, segment) => {
		if (typeof segment === "number") {
			return `${result}[${segment}]`;
		}
		const text = String(segment);
		return /^[A-Za-z_$][\w$]*$/.test(text)
			? `${result}.${text}`
			: `${result}[${JSON.stringify(text)}]`;
	}, "$");
}

export function receivedType(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

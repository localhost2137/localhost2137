const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export interface InstanceId {
	readonly kind: "instance-id";
	readonly value: string;
}

export interface ServiceKey {
	readonly kind: "service-key";
	readonly value: string;
}

export class InvalidIdentifierError extends Error {
	readonly field: "instance" | "service";
	readonly value: string;

	constructor(field: "instance" | "service", value: string, reason: string) {
		super(`Invalid ${field} identifier ${JSON.stringify(value)}: ${reason}`);
		this.name = "InvalidIdentifierError";
		this.field = field;
		this.value = value;
	}
}

export function parseInstanceId(value: string): InstanceId {
	validateIdentifier("instance", value);
	if (value === "_") {
		throw new InvalidIdentifierError("instance", value, '"_" is reserved');
	}
	return Object.freeze({ kind: "instance-id", value });
}

export function parseServiceKey(value: string): ServiceKey {
	validateIdentifier("service", value);
	return Object.freeze({ kind: "service-key", value });
}

function validateIdentifier(field: "instance" | "service", value: string): void {
	if (!IDENTIFIER_PATTERN.test(value)) {
		throw new InvalidIdentifierError(
			field,
			value,
			"expected a lowercase URL-safe value matching ^[a-z][a-z0-9-]{0,62}$",
		);
	}
}

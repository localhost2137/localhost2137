import type { ContractObservation } from "./contract-types.js";

export class PluginContractAssertionError extends Error {
	readonly caseName: string;

	constructor(caseName: string, message: string) {
		super(`${caseName}: ${message}`);
		this.name = "PluginContractAssertionError";
		this.caseName = caseName;
	}
}

export function assertContract(condition: boolean, caseName: string, message: string): void {
	if (!condition) throw new PluginContractAssertionError(caseName, message);
}

export function assertObservation(caseName: string, observation: unknown): void {
	assertContract(
		isObservation(observation),
		caseName,
		"probe must return exact actual/expected data properties",
	);
	if (!isObservation(observation)) return;
	assertContract(
		isContractDataEqual(observation.actual, observation.expected),
		caseName,
		`observation differed (actual ${render(observation.actual)}, expected ${render(observation.expected)})`,
	);
}

function isContractDataEqual(actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	if (Array.isArray(actual) || Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			Array.isArray(expected) &&
			actual.length === expected.length &&
			actual.every((value, index) => isContractDataEqual(value, expected[index]))
		);
	}
	if (!isPlainRecord(actual) || !isPlainRecord(expected)) return false;
	const actualKeys = Object.keys(actual).sort();
	const expectedKeys = Object.keys(expected).sort();
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every(
			(key, index) =>
				expectedKeys[index] === key &&
				isContractDataEqual(dataProperty(actual, key), dataProperty(expected, key)),
		)
	);
}

export function dataProperty(value: Readonly<Record<PropertyKey, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function isPlainRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function isRecordObject(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObservation(value: unknown): value is ContractObservation {
	if (!isPlainRecord(value)) return false;
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === 2 &&
		keys.includes("actual") &&
		keys.includes("expected") &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

function render(value: unknown): string {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) return String(value);
		return encoded.length <= 512 ? encoded : `${encoded.slice(0, 509)}...`;
	} catch {
		return Object.prototype.toString.call(value);
	}
}

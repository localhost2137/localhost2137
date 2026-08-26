import type { ServiceRecord } from "localhost2137";
import { isPlainRecord } from "./contract-assertions.js";
import type { PluginContractFixture } from "./contract-types.js";

const SERVICE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const OPERATION_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

export function validateFixture<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): void {
	if (!isPlainRecord(fixture))
		throw new TypeError("Plugin contract fixture must be a plain object.");
	if (!SERVICE_KEY_PATTERN.test(fixture.serviceKey)) {
		throw new TypeError(`Invalid selected service key ${fixture.serviceKey}.`);
	}
	if (!SERVICE_KEY_PATTERN.test(fixture.harness.pluginId)) {
		throw new TypeError(`Invalid selected plugin id ${fixture.harness.pluginId}.`);
	}
	if (!Number.isSafeInteger(fixture.harness.stateVersion) || fixture.harness.stateVersion < 1) {
		throw new TypeError("Selected plugin stateVersion must be a positive safe integer.");
	}
	if (fixture.operations.length === 0) {
		throw new TypeError("Plugin contract fixture must exercise at least one operation.");
	}
	const keys = new Set<string>();
	for (const operation of fixture.operations) {
		if (!OPERATION_KEY_PATTERN.test(operation.key)) {
			throw new TypeError(`Invalid fixture operation key ${operation.key}.`);
		}
		if (keys.has(operation.key)) {
			throw new TypeError(`Duplicate fixture operation ${operation.key}.`);
		}
		keys.add(operation.key);
	}
	for (const call of fixtureCalls(fixture)) {
		if (!keys.has(call.operation)) {
			throw new TypeError(`Contract call references undeclared operation ${call.operation}.`);
		}
		if (!isPlainRecord(call.input)) {
			throw new TypeError(`Contract call ${call.operation} input must be a plain object.`);
		}
	}
	if (!(fixture.authoring.module instanceof URL) || fixture.authoring.module.protocol !== "file:") {
		throw new TypeError("Authoring module must be a file URL.");
	}
	if (
		!(fixture.durability.configModule instanceof URL) ||
		fixture.durability.configModule.protocol !== "file:"
	) {
		throw new TypeError("Durability config module must be a file URL.");
	}
	if (!/^[A-Za-z_$][\w$]*$/.test(fixture.authoring.exportName)) {
		throw new TypeError("Authoring exportName must be a JavaScript identifier.");
	}
	const { old, current, future } = fixture.durability.versions;
	if (![old, current, future].every((value) => Number.isSafeInteger(value) && value > 0)) {
		throw new TypeError("Durability versions must be positive safe integers.");
	}
	if (!(old < current && current < future)) {
		throw new TypeError("Durability versions must be strictly ordered old < current < future.");
	}
}

function fixtureCalls<Services extends ServiceRecord>(fixture: PluginContractFixture<Services>) {
	return [
		...fixture.durability.arrange,
		fixture.durability.read,
		fixture.durability.write,
		fixture.faults.invalidOutput,
		fixture.faults.storageEscape,
		fixture.hono.arrange.first.invoke,
		fixture.hono.arrange.second.invoke,
		fixture.isolation.mutate,
		fixture.isolation.read,
		fixture.reset.mutate,
		fixture.reset.read,
		...fixture.trackedFetch.arrange,
		fixture.trackedFetch.invoke,
	] as const;
}

export function collisionServiceKeys(selected: string): readonly [string, string] {
	const first = `${selected}-contract-a`;
	const second = `${selected}-contract-b`;
	if (
		first === second ||
		first === selected ||
		second === selected ||
		!SERVICE_KEY_PATTERN.test(first) ||
		!SERVICE_KEY_PATTERN.test(second)
	) {
		throw new TypeError("Selected service key cannot produce distinct contract collision keys.");
	}
	return Object.freeze([first, second]);
}

export function issuePath(path: readonly PropertyKey[]): string {
	return path.reduce<string>((result, segment) => {
		if (typeof segment === "number") return `${result}[${segment}]`;
		const text = String(segment);
		return /^[A-Za-z_$][\w$]*$/.test(text)
			? `${result}.${text}`
			: `${result}[${JSON.stringify(text)}]`;
	}, "$");
}

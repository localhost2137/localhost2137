import { readdir } from "node:fs/promises";

interface ChildResult {
	readonly cwdChanged: boolean;
	readonly environmentChanged: readonly string[];
	readonly exportValid: boolean;
	readonly filesChanged: readonly string[];
	readonly resourcesAdded: readonly string[];
}

const moduleUrl = process.argv[2];
const exportName = process.argv[3];
const serviceKey = process.argv[4];
if (!moduleUrl || !exportName || !serviceKey || !process.send) process.exit(64);

const before = await snapshot();
const loaded: unknown = await import(moduleUrl);
await new Promise<void>((resolve) => setImmediate(resolve));
const after = await snapshot();
const exported = isRecord(loaded) ? Reflect.get(loaded, exportName) : undefined;
const services = isRecord(exported) ? Reflect.get(exported, "services") : undefined;
const result: ChildResult = Object.freeze({
	cwdChanged: before.cwd !== after.cwd,
	environmentChanged: changedEntries(before.environment, after.environment),
	exportValid: isRecord(services) && Object.hasOwn(services, serviceKey),
	filesChanged: changedEntries(before.files, after.files),
	resourcesAdded: addedResources(before.resources, after.resources),
});
process.send(result, (cause) => process.exit(cause ? 1 : 0));

async function snapshot() {
	return Object.freeze({
		cwd: process.cwd(),
		environment: Object.freeze({ ...process.env }),
		files: Object.freeze((await readdir(process.cwd(), { recursive: true })).sort()),
		resources: Object.freeze(process.getActiveResourcesInfo().sort()),
	});
}

function changedEntries(
	before: Readonly<Record<string, string | undefined>> | readonly string[],
	after: Readonly<Record<string, string | undefined>> | readonly string[],
): readonly string[] {
	if (Array.isArray(before) && Array.isArray(after)) {
		return Object.freeze(
			[...new Set([...before, ...after])]
				.filter((value) => !before.includes(value) || !after.includes(value))
				.sort(),
		);
	}
	const left = before as Readonly<Record<string, string | undefined>>;
	const right = after as Readonly<Record<string, string | undefined>>;
	return Object.freeze(
		[...new Set([...Object.keys(left), ...Object.keys(right)])]
			.filter((key) => left[key] !== right[key])
			.sort(),
	);
}

function addedResources(before: readonly string[], after: readonly string[]): readonly string[] {
	const counts = new Map<string, number>();
	for (const value of before) counts.set(value, (counts.get(value) ?? 0) + 1);
	const added: string[] = [];
	for (const value of after) {
		const remaining = counts.get(value) ?? 0;
		if (remaining > 0) counts.set(value, remaining - 1);
		else added.push(value);
	}
	return Object.freeze(added.sort());
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

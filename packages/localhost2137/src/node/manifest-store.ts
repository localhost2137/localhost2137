import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type InstanceManifest,
	parseInstanceManifest,
	parseServiceManifest,
	parseTransitionManifest,
	type ServiceManifest,
	type StorageTransitionManifest,
} from "../kernel/manifests.js";
import { type AtomicWriteOptions, writeJsonAtomically } from "./atomic-file.js";

export class ManifestReadError extends Error {
	override readonly cause: unknown;
	readonly filePath: string;

	constructor(filePath: string, cause: unknown) {
		super(`Could not read manifest at ${filePath}.`);
		this.name = "ManifestReadError";
		this.filePath = filePath;
		this.cause = cause;
	}
}

export class NodeManifestStore {
	readonly #writeOptions: AtomicWriteOptions;

	constructor(writeOptions: AtomicWriteOptions = {}) {
		this.#writeOptions = writeOptions;
	}

	async readInstance(filePath: string): Promise<InstanceManifest> {
		return parseInstanceManifest(await readJson(filePath), filePath);
	}

	async readService(filePath: string): Promise<ServiceManifest> {
		return parseServiceManifest(await readJson(filePath), filePath);
	}

	async readTransition(filePath: string): Promise<StorageTransitionManifest> {
		return parseTransitionManifest(await readJson(filePath), filePath);
	}

	async writeInstance(filePath: string, manifest: InstanceManifest): Promise<void> {
		await writeManifest(filePath, parseInstanceManifest(manifest, filePath), this.#writeOptions);
	}

	async writeService(filePath: string, manifest: ServiceManifest): Promise<void> {
		await writeManifest(filePath, parseServiceManifest(manifest, filePath), this.#writeOptions);
	}

	async writeTransition(filePath: string, manifest: StorageTransitionManifest): Promise<void> {
		await writeManifest(filePath, parseTransitionManifest(manifest, filePath), this.#writeOptions);
	}
}

async function readJson(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (cause) {
		throw new ManifestReadError(filePath, cause);
	}
}

async function writeManifest(
	filePath: string,
	manifest: unknown,
	options: AtomicWriteOptions,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeJsonAtomically(filePath, manifest, options);
}

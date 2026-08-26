import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigError } from "../config/config-error.js";
import type { ResolvedConfig } from "../config/config-resolution.js";
import { loadResolvedConfig } from "../config/load-config.js";
import { discoverActiveRuntime, RuntimeDiscoveryError } from "./active-runtime-discovery.js";
import { NodeManifestStore } from "./manifest-store.js";
import { storagePaths } from "./storage-paths.js";

export interface RuntimeDoctorOptions {
	readonly cwd: string;
	readonly fetch?: typeof globalThis.fetch;
}

export interface RuntimeDoctorDependencies {
	readonly discoverRuntime?: typeof discoverActiveRuntime;
	readonly loadConfig?: typeof loadResolvedConfig;
	readonly manifests?: NodeManifestStore;
}

interface RuntimeDoctorIssue {
	readonly code: string;
	readonly instanceId?: string;
	readonly message: string;
	readonly serviceKey?: string;
}

export interface RuntimeDoctorReport {
	readonly config: Readonly<{
		errorCode?: string;
		fingerprint?: string;
		loaded: boolean;
		path?: string;
		storageRoot: string;
	}>;
	readonly issues: readonly RuntimeDoctorIssue[];
	readonly runtime: Readonly<{
		errorCode?: string;
		pid?: number;
		state: "absent" | "healthy" | "unhealthy";
		url?: string;
	}>;
	readonly status: "issues" | "ok";
	readonly storage: Readonly<{
		instances: readonly Readonly<{
			createdAt: string;
			id: string;
			persistence: "ephemeral" | "persistent";
			seedStatus: string;
			services: readonly string[];
			status: string;
		}>[];
		root: string;
		trashEntries: readonly string[];
	}>;
}

/** Inspects config/runtime/storage without creating directories or repairing state. */
export async function inspectProjectRuntime(
	options: RuntimeDoctorOptions,
	dependencies: RuntimeDoctorDependencies = {},
): Promise<RuntimeDoctorReport> {
	const issues: RuntimeDoctorIssue[] = [];
	const config = await readConfig(
		options.cwd,
		dependencies.loadConfig ?? loadResolvedConfig,
		issues,
	);
	const storageRoot = config.value?.storage.dir ?? resolve(options.cwd, ".localhost2137");
	const paths = storagePaths(storageRoot);
	const runtime = await inspectRuntime(
		storageRoot,
		config.value,
		options.fetch,
		dependencies.discoverRuntime ?? discoverActiveRuntime,
		issues,
	);
	const storage = await inspectStorage(
		paths,
		config.value,
		dependencies.manifests ?? new NodeManifestStore(),
		issues,
	);
	return Object.freeze({
		config: Object.freeze({
			...(config.errorCode ? { errorCode: config.errorCode } : {}),
			...(config.value
				? { fingerprint: config.value.fingerprint, path: config.value.configPath }
				: {}),
			loaded: config.value !== undefined,
			storageRoot,
		}),
		issues: Object.freeze(issues),
		runtime,
		status: issues.length === 0 ? "ok" : "issues",
		storage,
	});
}

async function readConfig(
	cwd: string,
	load: typeof loadResolvedConfig,
	issues: RuntimeDoctorIssue[],
): Promise<Readonly<{ errorCode?: string; value?: ResolvedConfig }>> {
	try {
		return Object.freeze({ value: await load({ cwd }) });
	} catch (cause) {
		const errorCode = cause instanceof ConfigError ? cause.code : "CONFIG_READ_FAILED";
		issues.push(
			issue(errorCode, cause instanceof Error ? cause.message : "Could not load project config."),
		);
		return Object.freeze({ errorCode });
	}
}

async function inspectRuntime(
	storageRoot: string,
	config: ResolvedConfig | undefined,
	fetch: typeof globalThis.fetch | undefined,
	discover: typeof discoverActiveRuntime,
	issues: RuntimeDoctorIssue[],
): Promise<RuntimeDoctorReport["runtime"]> {
	try {
		const active = await discover(storageRoot, fetch ? { fetch } : {});
		if (config && active.descriptor.configFingerprint !== config.fingerprint) {
			issues.push(
				issue(
					"RUNTIME_CONFIG_MISMATCH",
					"The active runtime was started from a different resolved configuration.",
				),
			);
		}
		return Object.freeze({
			pid: active.descriptor.pid,
			state: "healthy",
			url: active.descriptor.url,
		});
	} catch (cause) {
		if (cause instanceof RuntimeDiscoveryError) {
			if (cause.code === "RUNTIME_NOT_FOUND") {
				const tokenExists = await pathExists(storagePaths(storageRoot).controlToken);
				if (tokenExists) {
					issues.push(
						issue(
							"RUNTIME_FILES_INCONSISTENT",
							"The fixed control-token file exists without an active runtime descriptor.",
						),
					);
					return Object.freeze({
						errorCode: "RUNTIME_FILES_INCONSISTENT",
						state: "unhealthy",
					});
				}
			} else {
				issues.push(issue(cause.code, cause.message));
			}
			return Object.freeze({
				errorCode: cause.code,
				state: cause.code === "RUNTIME_NOT_FOUND" ? "absent" : "unhealthy",
			});
		}
		issues.push(issue("RUNTIME_INSPECTION_FAILED", "Could not inspect the active runtime."));
		return Object.freeze({ errorCode: "RUNTIME_INSPECTION_FAILED", state: "unhealthy" });
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (cause) {
		if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) return false;
		throw cause;
	}
}

async function inspectStorage(
	paths: ReturnType<typeof storagePaths>,
	config: ResolvedConfig | undefined,
	manifests: NodeManifestStore,
	issues: RuntimeDoctorIssue[],
): Promise<RuntimeDoctorReport["storage"]> {
	const instances: Array<RuntimeDoctorReport["storage"]["instances"][number]> = [];
	for (const entry of await directoryNames(paths.instances)) {
		const instancePath = resolve(paths.instances, entry);
		try {
			const manifest = await manifests.readInstance(resolve(instancePath, "instance.json"));
			if (manifest.id !== entry) {
				issues.push(
					issue("INSTANCE_DIRECTORY_MISMATCH", "Instance manifest ID differs from its directory.", {
						instanceId: entry,
					}),
				);
			}
			if (config && manifest.configFingerprint !== config.fingerprint) {
				issues.push(
					issue(
						"INSTANCE_CONFIG_MISMATCH",
						"Instance metadata was last reconciled with a different configuration.",
						{ instanceId: manifest.id },
					),
				);
			}
			const services = await inspectServices(instancePath, manifest.id, config, manifests, issues);
			instances.push(
				Object.freeze({
					createdAt: manifest.createdAt,
					id: manifest.id,
					persistence: manifest.persistence,
					seedStatus: manifest.seed.status,
					services,
					status: manifest.status,
				}),
			);
		} catch {
			issues.push(
				issue("INSTANCE_MANIFEST_INVALID", "Instance manifest is missing or invalid.", {
					instanceId: entry,
				}),
			);
		}
	}
	const trashEntries = Object.freeze(await directoryNames(paths.trash));
	if (trashEntries.length > 0) {
		issues.push(
			issue(
				"PENDING_TRASH",
				`Storage contains ${trashEntries.length} pending trash transition(s).`,
			),
		);
	}
	return Object.freeze({ instances: Object.freeze(instances), root: paths.root, trashEntries });
}

async function inspectServices(
	instancePath: string,
	instanceId: string,
	config: ResolvedConfig | undefined,
	manifests: NodeManifestStore,
	issues: RuntimeDoctorIssue[],
): Promise<readonly string[]> {
	const names = await directoryNames(resolve(instancePath, "services"));
	for (const serviceKey of names) {
		try {
			const manifest = await manifests.readService(
				resolve(instancePath, "services", serviceKey, "service.json"),
			);
			const configured = config?.services[serviceKey];
			if (!configured) {
				if (config) {
					issues.push(
						issue("ORPHANED_SERVICE", "Stored service is no longer configured.", {
							instanceId,
							serviceKey,
						}),
					);
				}
				continue;
			}
			if (manifest.pluginId !== configured.pluginId) {
				issues.push(
					issue("SERVICE_PLUGIN_MISMATCH", "Stored service belongs to a different plugin.", {
						instanceId,
						serviceKey,
					}),
				);
			}
			if (manifest.stateVersion !== configured.stateVersion) {
				issues.push(
					issue(
						manifest.stateVersion > configured.stateVersion
							? "SERVICE_STATE_NEWER"
							: "SERVICE_STATE_OUTDATED",
						"Stored service state version differs from the configured plugin.",
						{ instanceId, serviceKey },
					),
				);
			}
		} catch {
			issues.push(
				issue("SERVICE_MANIFEST_INVALID", "Service manifest is missing or invalid.", {
					instanceId,
					serviceKey,
				}),
			);
		}
	}
	return Object.freeze(names);
}

async function directoryNames(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort(codeUnitOrder);
	} catch (cause) {
		if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) return [];
		throw cause;
	}
}

function issue(
	code: string,
	message: string,
	details: Readonly<{ instanceId?: string; serviceKey?: string }> = {},
): RuntimeDoctorIssue {
	return Object.freeze({ code, ...details, message });
}

function codeUnitOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}

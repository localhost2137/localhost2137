import type { ResolvedConfig } from "../config/config-resolution.js";
import type { ResolvedInstanceConnections } from "../config/instance-connections.js";
import { resolveInstanceConnections } from "../config/instance-connections.js";
import { loadResolvedConfig } from "../config/load-config.js";
import type { RuntimeDescriptor } from "../control/runtime-descriptor.js";
import { InstanceNotFoundError } from "../kernel/instance-manager.js";
import {
	ActiveRuntimeFileStore,
	createRuntimeDescriptor,
	generateControlToken,
} from "./active-runtime-file-store.js";
import { createDevProjectRuntime } from "./dev-runtime-dependencies.js";
import { writeGeneratedDevEnvironment } from "./generated-environment-file.js";
import { type HttpServerAddress, type LoopbackHost, ownHttpServerOptions } from "./http-server.js";
import type { ProjectRuntimeComposition } from "./project-runtime.js";
import { acquireStorageLock, type StorageLock } from "./storage-lock.js";
import { storagePaths } from "./storage-paths.js";

const DEV_INSTANCE_ID = "dev";
const SHUTDOWN_TIMEOUT_MS = 30_000;

export interface DevDaemonOptions {
	readonly configPath?: string;
	readonly cwd: string;
	readonly host?: LoopbackHost;
	readonly port?: number;
}

export interface DevDaemon {
	readonly address: HttpServerAddress;
	readonly config: ResolvedConfig;
	readonly connections: ResolvedInstanceConnections;
	readonly descriptor: RuntimeDescriptor;
	readonly environmentPath: string;
	readonly fatal: Promise<unknown>;
	close(): Promise<void>;
}

interface ActiveRuntimeOwner {
	publish(descriptor: unknown, token: unknown): Promise<void>;
	remove(ownerId: string): Promise<boolean>;
}

export interface DevDaemonDependencyOverrides {
	readonly acquireLock?: typeof acquireStorageLock;
	readonly createActiveRuntimeOwner?: (storageRoot: string) => ActiveRuntimeOwner;
	readonly createControlToken?: () => string;
	readonly createRuntime?: (
		config: ResolvedConfig,
		controlToken: string,
	) => ProjectRuntimeComposition;
	readonly loadConfig?: typeof loadResolvedConfig;
	readonly writeEnvironment?: typeof writeGeneratedDevEnvironment;
}

/**
 * Boots and owns one daemon as a transaction. The storage lock is always the
 * last resource released, after the server and every retained task settle.
 */
export async function startDevDaemon(
	options: DevDaemonOptions,
	overrides: DevDaemonDependencyOverrides = {},
): Promise<DevDaemon> {
	const loadConfig = overrides.loadConfig ?? loadResolvedConfig;
	const config = await loadConfig({
		cwd: options.cwd,
		...(options.configPath === undefined ? {} : { explicitPath: options.configPath }),
	});
	const serverOptions = ownHttpServerOptions({
		host: options.host ?? config.host,
		port: options.port ?? config.port,
	});
	const effectiveConfig = withEndpoint(config, serverOptions);
	const acquireLock = overrides.acquireLock ?? acquireStorageLock;
	const lock = await acquireLock(storagePaths(config.storage.dir));
	const fatalEvent = deferred<unknown>();
	let activeRuntime: ActiveRuntimeOwner | undefined;
	let fatalOccurred = false;
	let publicationAttempted = false;
	let publishedDescriptor: RuntimeDescriptor | undefined;
	let ready = false;
	let runtime: ProjectRuntimeComposition | undefined;
	let cleanupPromise: Promise<readonly unknown[]> | undefined;

	const cleanup = (): Promise<readonly unknown[]> => {
		cleanupPromise ??= cleanOwnedResources({
			getActiveRuntime: () => activeRuntime,
			getDescriptor: () => publishedDescriptor,
			getPublicationAttempted: () => publicationAttempted,
			lock,
			getRuntime: () => runtime,
		});
		return cleanupPromise;
	};
	const close = async (): Promise<void> => {
		const failures = await cleanup();
		if (failures.length > 0) {
			throw new AggregateError(failures, "Dev daemon shutdown had failures.");
		}
	};

	try {
		const controlToken = (overrides.createControlToken ?? generateControlToken)();
		const createRuntime = overrides.createRuntime ?? createDevProjectRuntime;
		runtime = createRuntime(effectiveConfig, controlToken);
		activeRuntime = (
			overrides.createActiveRuntimeOwner ??
			((storageRoot) => new ActiveRuntimeFileStore(storageRoot))
		)(config.storage.dir);
		runtime.server.onFatal((cause) => {
			if (fatalOccurred) return;
			fatalOccurred = true;
			fatalEvent.resolve(cause);
			if (ready) void close().catch(() => undefined);
		});
		await runtime.instances.startPersisted();
		await ensureDevInstance(runtime);
		const address = await runtime.server.start(serverOptions);
		const descriptor = createRuntimeDescriptor({
			configFingerprint: config.fingerprint,
			url: address.url,
		});
		publishedDescriptor = descriptor;
		publicationAttempted = true;
		await activeRuntime.publish(descriptor, controlToken);
		const connections = resolveInstanceConnections(config, {
			baseUrl: address.url,
			instanceId: DEV_INSTANCE_ID,
		});
		const environmentPath = await (overrides.writeEnvironment ?? writeGeneratedDevEnvironment)(
			config.storage.dir,
			connections.env,
		);
		if (fatalOccurred) {
			throw new Error("The runtime server failed while the dev daemon was starting.");
		}
		ready = true;
		return Object.freeze({
			address,
			close,
			config,
			connections,
			descriptor,
			environmentPath,
			fatal: fatalEvent.promise,
		});
	} catch (cause) {
		const cleanupFailures = await cleanup();
		if (cleanupFailures.length > 0) {
			throw new AggregateError(
				[cause, ...cleanupFailures],
				"Dev daemon startup failed and cleanup was incomplete.",
			);
		}
		throw cause;
	}
}

function withEndpoint(
	config: ResolvedConfig,
	endpoint: Readonly<{ host: LoopbackHost; port: number }>,
): ResolvedConfig {
	return Object.freeze({ ...config, host: endpoint.host, port: endpoint.port });
}

async function ensureDevInstance(runtime: ProjectRuntimeComposition): Promise<void> {
	try {
		await runtime.instances.get(DEV_INSTANCE_ID);
	} catch (cause) {
		if (!(cause instanceof InstanceNotFoundError)) throw cause;
		await runtime.instances.create({
			id: DEV_INSTANCE_ID,
			persistence: "persistent",
			seed: false,
		});
	}
}

async function cleanOwnedResources(
	input: Readonly<{
		getActiveRuntime(): ActiveRuntimeOwner | undefined;
		getDescriptor(): RuntimeDescriptor | undefined;
		getPublicationAttempted(): boolean;
		getRuntime(): ProjectRuntimeComposition | undefined;
		lock: StorageLock;
	}>,
): Promise<readonly unknown[]> {
	const failures: unknown[] = [];
	const descriptor = input.getDescriptor();
	const activeRuntime = input.getActiveRuntime();
	if (input.getPublicationAttempted() && descriptor && activeRuntime) {
		await activeRuntime.remove(descriptor.ownerId).catch((cause: unknown) => failures.push(cause));
	}
	const runtime = input.getRuntime();
	if (runtime) {
		await runtime.server.close(SHUTDOWN_TIMEOUT_MS).catch((cause: unknown) => failures.push(cause));
		await invokeSettlement(runtime).catch((cause: unknown) => failures.push(cause));
	}
	await input.lock.release().catch((cause: unknown) => failures.push(cause));
	return Object.freeze(failures);
}

async function invokeSettlement(runtime: ProjectRuntimeComposition): Promise<void> {
	await runtime.server.settled();
}

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}

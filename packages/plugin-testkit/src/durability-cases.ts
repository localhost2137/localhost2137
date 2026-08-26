import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceRecord } from "localhost2137";
import { connectRuntime, type RuntimeClient } from "localhost2137/client";
import { capture, finishCaptured } from "./cleanup-owner.js";
import { assertContract, assertContractEqual, isPlainRecord } from "./contract-assertions.js";
import { type OwnedContractResources, withContractResources } from "./contract-resources.js";
import type { PluginContractCase, PluginContractFixture } from "./contract-types.js";
import {
	CONTRACT_FAIL_TIME_ADVANCE_ENV,
	CONTRACT_TIME_ADVANCE_EVENT_PREFIX,
} from "./durability-fixture-protocol.js";
import { stopSupervisedProcess } from "./durability-process.js";
import { assertSelectedServiceIdentity } from "./service-identity.js";

const INSTANCE_ID = "dev";
const DAEMON_DEADLINE_MS = 10_000;

const contractProcessEnvironment: Readonly<{
	events: string;
	deliveryUrl: string;
	failUpdate: string;
	storage: string;
	version: string;
}> = Object.freeze({
	events: "LOCALHOST2137_CONTRACT_EVENTS",
	deliveryUrl: "LOCALHOST2137_CONTRACT_DELIVERY_URL",
	failUpdate: "LOCALHOST2137_CONTRACT_FAIL_UPDATE",
	storage: "LOCALHOST2137_CONTRACT_STORAGE",
	version: "LOCALHOST2137_CONTRACT_VERSION",
});

export function durabilityCases<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): readonly PluginContractCase[] {
	const cases: PluginContractCase[] = [
		contractCase("update failure is recoverable", () => updateRecoveryCase(fixture)),
		contractCase("state persists across runtime restart", () => restartPersistenceCase(fixture)),
		contractCase("future stored state versions are rejected", () => futureVersionCase(fixture)),
		contractCase("state-version upgrades preserve data", () => stateUpgradeCase(fixture)),
	];
	if (fixture.durability.timeAdvance) {
		cases.push(
			contractCase("committed time advance recovers before restart readiness", () =>
				timeAdvanceRecoveryCase(fixture),
			),
		);
	}
	if (fixture.durability.startupRecovery) {
		cases.push(
			contractCase("pending delivery recovers before restart readiness", () =>
				startupRecoveryCase(fixture),
			),
		);
	}
	return Object.freeze(cases);
}

async function restartPersistenceCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "state persists across runtime restart";
	await withDurabilityRoot(fixture, async (owner) => {
		const first = await owner.start(fixture.durability.versions.current, {}, name);
		await arrange(first.client, fixture);
		assertContractEqual(
			await execute(first.client, fixture, fixture.durability.read),
			fixture.durability.expectedInitial,
			name,
		);
		assertContractEqual(
			await execute(first.client, fixture, fixture.durability.write),
			fixture.durability.expectedWrite,
			name,
		);
		await first.stop();
		const second = await owner.start(fixture.durability.versions.current, {}, name);
		assertContractEqual(
			await execute(second.client, fixture, fixture.durability.read),
			fixture.durability.expectedPersisted,
			name,
		);
		await second.stop();
	});
}

async function futureVersionCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "future stored state versions are rejected";
	await withDurabilityRoot(fixture, async (owner) => {
		const future = await owner.start(fixture.durability.versions.future, {}, name);
		await future.stop();
		const exitCode = await owner.expectFailure(fixture.durability.versions.current, {});
		assertContract(
			exitCode !== 0 || exitCode === null,
			name,
			"future stored version started successfully",
		);
	});
}

async function stateUpgradeCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "state-version upgrades preserve data";
	await withDurabilityRoot(fixture, async (owner) => {
		const old = await owner.start(fixture.durability.versions.old, {}, name);
		await arrange(old.client, fixture);
		await execute(old.client, fixture, fixture.durability.write);
		await old.stop();
		const current = await owner.start(fixture.durability.versions.current, {}, name);
		assertContractEqual(
			await execute(current.client, fixture, fixture.durability.read),
			fixture.durability.expectedPersisted,
			name,
		);
		await current.stop();
		assertContractEqual(
			await owner.events(),
			[`update:${fixture.durability.versions.old}:${fixture.durability.versions.current}`],
			name,
		);
	});
}

async function updateRecoveryCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "update failure is recoverable";
	await withDurabilityRoot(fixture, async (owner) => {
		const old = await owner.start(fixture.durability.versions.old, {}, name);
		await arrange(old.client, fixture);
		await execute(old.client, fixture, fixture.durability.write);
		await old.stop();
		const exitCode = await owner.expectFailure(fixture.durability.versions.current, {
			update: true,
		});
		assertContract(
			exitCode !== 0 || exitCode === null,
			name,
			"injected update failure started successfully",
		);
		const recovered = await owner.start(fixture.durability.versions.current, {}, name);
		assertContractEqual(
			await execute(recovered.client, fixture, fixture.durability.read),
			fixture.durability.expectedPersisted,
			name,
		);
		await recovered.stop();
		const event = `update:${fixture.durability.versions.old}:${fixture.durability.versions.current}`;
		assertContractEqual(await owner.events(), [event, event], name);
	});
}

async function timeAdvanceRecoveryCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "committed time advance recovers before restart readiness";
	const specification = fixture.durability.timeAdvance;
	if (!specification) throw new TypeError("Time-advance durability specification is missing.");
	await withDurabilityRoot(fixture, async (owner) => {
		const first = await owner.start(
			fixture.durability.versions.current,
			{ timeAdvance: true },
			name,
		);
		for (const call of specification.arrange) await execute(first.client, fixture, call);
		await first.client.idle(INSTANCE_ID);
		assertContractEqual(owner.deliveryCount(), specification.deliveries.afterArrange, name);

		const advance = await capture(() =>
			first.client.clockAdvance(INSTANCE_ID, specification.duration),
		);
		assertContract(advance.status === "rejected", name, "faulted clock advance resolved");
		if (advance.status !== "rejected") return;
		const details = errorDetails(advance.reason);
		assertContract(
			errorProperty(advance.reason, "code") === "INSTANCE_MUTATION_COMMITTED",
			name,
			"faulted clock advance did not report a committed mutation",
		);
		assertContract(
			details?.reconciliationPending === true,
			name,
			"faulted clock advance did not remain pending",
		);
		await assertObservations(first.client, fixture, specification.observations, name);
		assertContractEqual(
			owner.deliveryCount(),
			specification.deliveries.afterCommittedAdvance,
			name,
		);
		await first.stop();

		const pending = await owner.pendingTimeAdvance(name);
		assertContract(pending !== undefined, name, "committed advance was not persisted");
		if (!pending) return;
		assertContract(
			pending.services.includes(fixture.serviceKey) &&
				!pending.acknowledgedServices.includes(fixture.serviceKey),
			name,
			"selected service was unexpectedly acknowledged after its injected failure",
		);
		assertContractEqual(details?.advanceId, pending.id, name);
		assertContractEqual(details?.from, new Date(pending.fromMs).toISOString(), name);
		assertContractEqual(details?.to, new Date(pending.toMs).toISOString(), name);

		const second = await owner.start(fixture.durability.versions.current, {}, name);
		assertContract(
			(await owner.pendingTimeAdvance(name)) === undefined,
			name,
			"runtime published readiness before clearing the recovered advance",
		);
		await second.client.idle(INSTANCE_ID);
		assertContractEqual(owner.deliveryCount(), specification.deliveries.afterRecovery, name);
		await assertObservations(second.client, fixture, specification.observations, name);

		const expectedRecord = Object.freeze({
			advanceId: pending.id,
			from: new Date(pending.fromMs).toISOString(),
			to: new Date(pending.toMs).toISOString(),
		});
		const records = (await owner.events())
			.filter((event) => event.startsWith(CONTRACT_TIME_ADVANCE_EVENT_PREFIX))
			.map((event) => parseTimeAdvanceEvent(event, name));
		assertContractEqual(records, [expectedRecord, expectedRecord], name);
		await second.stop();
	});
}

async function startupRecoveryCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "pending delivery recovers before restart readiness";
	const specification = fixture.durability.startupRecovery;
	if (!specification) throw new TypeError("Startup-recovery durability specification is missing.");
	await withDurabilityRoot(
		fixture,
		async (owner) => {
			const first = await owner.start(fixture.durability.versions.current, {}, name);
			for (const call of specification.arrange) await execute(first.client, fixture, call);
			await owner.deliveryEntered();
			assertContractEqual(owner.deliveryCount(), specification.deliveries.afterInterruption, name);

			await first.crash();
			owner.releaseDeliveries();

			const second = await owner.start(fixture.durability.versions.current, {}, name);
			assertContractEqual(owner.deliveryCount(), specification.deliveries.afterRecovery, name);
			await assertObservations(second.client, fixture, specification.observations, name);
			await second.stop();
		},
		{ holdDelivery: true },
	);
}

interface RunningDaemon {
	readonly client: RuntimeClient;
	crash(): Promise<number | null>;
	stop(): Promise<number | null>;
}

interface SpawnedDaemon {
	readonly closed: Promise<number | null>;
	readonly process: ChildProcess;
	crash(): Promise<number | null>;
	stop(): Promise<number | null>;
}

interface DurabilityFaults {
	readonly timeAdvance?: boolean;
	readonly update?: boolean;
}

interface PendingTimeAdvance {
	readonly acknowledgedServices: readonly string[];
	readonly fromMs: number;
	readonly id: string;
	readonly services: readonly string[];
	readonly toMs: number;
}

interface DurabilityOwner {
	deliveryEntered(): Promise<void>;
	deliveryCount(): number;
	events(): Promise<readonly string[]>;
	expectFailure(version: number, faults: DurabilityFaults): Promise<number | null>;
	pendingTimeAdvance(caseName: string): Promise<PendingTimeAdvance | undefined>;
	releaseDeliveries(): void;
	start(version: number, faults: DurabilityFaults, caseName: string): Promise<RunningDaemon>;
}

async function withDurabilityRoot<Services extends ServiceRecord, Value>(
	fixture: PluginContractFixture<Services>,
	work: (owner: DurabilityOwner) => Promise<Value>,
	resources: Readonly<{ holdDelivery?: boolean }> = {},
): Promise<Value> {
	return withContractResources(resources, (ownedResources) =>
		withOwnedDurabilityRoot(fixture, ownedResources, work),
	);
}

async function withOwnedDurabilityRoot<Services extends ServiceRecord, Value>(
	fixture: PluginContractFixture<Services>,
	resources: OwnedContractResources,
	work: (owner: DurabilityOwner) => Promise<Value>,
): Promise<Value> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-contract-durable-"));
	const eventsPath = join(root, "events.log");
	await writeFile(eventsPath, "", "utf8");
	const activeStops = new Set<() => Promise<number | null>>();
	const daemonCwd = await nearestPackageRoot(fileURLToPath(fixture.durability.configModule));
	const supervisorSource = supervisorModuleUrl();
	const spawnOwned = async (version: number, faults: DurabilityFaults): Promise<SpawnedDaemon> => {
		await waitForDurabilityRelease(root);
		const port = await availablePort();
		const inheritedEnvironment = { ...process.env };
		delete inheritedEnvironment.LOCALHOST_CONTROL_TOKEN;
		const childArguments = [fileURLToPath(supervisorSource)];
		if (supervisorSource.pathname.endsWith(".ts")) {
			childArguments.unshift("--experimental-strip-types");
		}
		childArguments.push(
			"--config",
			fileURLToPath(fixture.durability.configModule),
			"dev",
			"--port",
			String(port),
		);
		const child = spawn(process.execPath, childArguments, {
			cwd: daemonCwd,
			env: {
				...inheritedEnvironment,
				[contractProcessEnvironment.deliveryUrl]: resources.harness.deliveryUrl,
				[contractProcessEnvironment.events]: eventsPath,
				[CONTRACT_FAIL_TIME_ADVANCE_ENV]: faults.timeAdvance ? "1" : "0",
				[contractProcessEnvironment.failUpdate]: faults.update ? "1" : "0",
				[contractProcessEnvironment.storage]: root,
				[contractProcessEnvironment.version]: String(version),
			},
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const closed = processExit(child);
		let crashPromise: Promise<number | null> | undefined;
		let stopPromise: Promise<number | null> | undefined;
		const stop = (): Promise<number | null> => {
			if (crashPromise) return crashPromise;
			if (!stopPromise) {
				stopPromise = stopSupervisedProcess(child, closed).then(async (result) => {
					if (!result.forced) await waitForDurabilityRelease(root);
					return result.exitCode;
				});
				void stopPromise.then(
					() => activeStops.delete(stop),
					() => activeStops.delete(stop),
				);
			}
			return stopPromise;
		};
		const crash = (): Promise<number | null> => {
			if (stopPromise) return Promise.reject(new TypeError("Cannot crash a stopping daemon."));
			if (!crashPromise) {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				crashPromise = closed.then(async (exitCode) => {
					await clearCrashedRuntimeOwnership(root);
					return exitCode;
				});
				void crashPromise.then(
					() => activeStops.delete(stop),
					() => activeStops.delete(stop),
				);
			}
			return crashPromise;
		};
		activeStops.add(stop);
		return Object.freeze({
			closed,
			crash,
			process: child,
			stop,
		});
	};
	const owner: DurabilityOwner = Object.freeze({
		deliveryEntered: () => resources.deliveries.entered,
		deliveryCount: resources.deliveries.count,
		events: async () =>
			Object.freeze((await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)),
		expectFailure: async (version: number, faults: DurabilityFaults) => {
			const daemon = await spawnOwned(version, faults);
			try {
				return await waitForFailure(root, daemon);
			} finally {
				await daemon.stop();
			}
		},
		pendingTimeAdvance: (caseName: string) => readPendingTimeAdvance(root, caseName),
		releaseDeliveries: resources.deliveries.release,
		start: async (version: number, faults: DurabilityFaults, caseName: string) => {
			const daemon = await spawnOwned(version, faults);
			try {
				const descriptor = await waitForDescriptor(root, daemon);
				assertContract(
					descriptor.pid === daemon.process.pid,
					caseName,
					"runtime descriptor pid differs from the owned daemon process",
				);
				const token = (await readFile(join(root, "control-token"), "utf8")).trim();
				const client = connectRuntime({ token, url: descriptor.url });
				await assertSelectedServiceIdentity(client, INSTANCE_ID, fixture, caseName, version);
				return Object.freeze({ client, crash: daemon.crash, stop: daemon.stop });
			} catch (cause) {
				const cleanup = await capture(() => daemon.stop());
				if (cleanup.status === "rejected") {
					throw new AggregateError([cause, cleanup.reason], "Durability boot and cleanup failed.");
				}
				throw cause;
			}
		},
	});
	const outcome = await capture(() => work(owner));
	const cleanupFailures: unknown[] = [];
	for (const result of await Promise.allSettled([...activeStops].map((stop) => stop()))) {
		if (result.status === "rejected") cleanupFailures.push(result.reason);
	}
	await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 }).catch(
		(cause: unknown) => cleanupFailures.push(cause),
	);
	return finishCaptured(outcome, cleanupFailures, "Durability contract case");
}

async function execute<Services extends ServiceRecord>(
	client: RuntimeClient,
	fixture: PluginContractFixture<Services>,
	call: Readonly<{ input: unknown; operation: string }>,
): Promise<unknown> {
	return client.executeOperation(
		INSTANCE_ID,
		fixture.serviceKey,
		call.operation,
		call.input as never,
	);
}

async function arrange<Services extends ServiceRecord>(
	client: RuntimeClient,
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	for (const call of fixture.durability.arrange) await execute(client, fixture, call);
}

async function assertObservations<Services extends ServiceRecord>(
	client: RuntimeClient,
	fixture: PluginContractFixture<Services>,
	observations: readonly Readonly<{
		expected: unknown;
		read: Readonly<{ input: unknown; operation: string }>;
	}>[],
	caseName: string,
): Promise<void> {
	for (const observation of observations) {
		assertContractEqual(
			await execute(client, fixture, observation.read),
			observation.expected,
			caseName,
		);
	}
}

function errorDetails(value: unknown): Readonly<Record<PropertyKey, unknown>> | undefined {
	const details = errorProperty(value, "details");
	return isPlainRecord(details) ? details : undefined;
}

function errorProperty(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function parseTimeAdvanceEvent(
	event: string,
	caseName: string,
): Readonly<{ advanceId: string; from: string; to: string }> {
	let value: unknown;
	try {
		value = JSON.parse(event.slice(CONTRACT_TIME_ADVANCE_EVENT_PREFIX.length));
	} catch {
		return contractFailure(caseName, "time-advance fixture emitted invalid JSON");
	}
	if (!isPlainRecord(value)) {
		return contractFailure(caseName, "time-advance fixture emitted a non-object record");
	}
	const advanceId = value.advanceId;
	const from = value.from;
	const to = value.to;
	if (
		typeof advanceId !== "string" ||
		typeof from !== "string" ||
		typeof to !== "string" ||
		!Number.isFinite(Date.parse(from)) ||
		!Number.isFinite(Date.parse(to))
	) {
		return contractFailure(caseName, "time-advance fixture emitted an invalid record");
	}
	return Object.freeze({ advanceId, from, to });
}

async function readPendingTimeAdvance(
	root: string,
	caseName: string,
): Promise<PendingTimeAdvance | undefined> {
	let manifest: unknown;
	try {
		manifest = JSON.parse(
			await readFile(join(root, "instances", INSTANCE_ID, "instance.json"), "utf8"),
		);
	} catch {
		return contractFailure(caseName, "could not read the persisted instance manifest");
	}
	if (!isPlainRecord(manifest)) {
		return contractFailure(caseName, "persisted instance manifest is not an object");
	}
	const value = manifest.timeAdvance;
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) {
		return contractFailure(caseName, "pending time advance is not an object");
	}
	const acknowledgedServices = value.acknowledgedServices;
	const fromMs = value.fromMs;
	const id = value.id;
	const services = value.services;
	const toMs = value.toMs;
	if (
		!Array.isArray(acknowledgedServices) ||
		!acknowledgedServices.every((service) => typeof service === "string") ||
		!Number.isSafeInteger(fromMs) ||
		typeof id !== "string" ||
		!Array.isArray(services) ||
		!services.every((service) => typeof service === "string") ||
		!Number.isSafeInteger(toMs) ||
		Number(toMs) <= Number(fromMs)
	) {
		return contractFailure(caseName, "pending time advance has an invalid shape");
	}
	return Object.freeze({
		acknowledgedServices: Object.freeze([...acknowledgedServices]) as readonly string[],
		fromMs: Number(fromMs),
		id,
		services: Object.freeze([...services]) as readonly string[],
		toMs: Number(toMs),
	});
}

function contractFailure(caseName: string, message: string): never {
	assertContract(false, caseName, message);
	throw new TypeError("Unreachable contract assertion.");
}

async function waitForDescriptor(
	root: string,
	daemon: SpawnedDaemon,
): Promise<Readonly<{ pid: number; url: string }>> {
	const deadline = Date.now() + DAEMON_DEADLINE_MS;
	while (Date.now() < deadline) {
		const descriptor = await readDescriptor(root);
		if (descriptor) return descriptor;
		if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) {
			throw new Error("Durability daemon exited before publishing readiness.");
		}
		await tick();
	}
	throw new Error("Durability daemon exceeded its bounded readiness deadline.");
}

async function waitForFailure(root: string, daemon: SpawnedDaemon): Promise<number | null> {
	const deadline = Date.now() + DAEMON_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (await readDescriptor(root)) {
			throw new Error("Durability daemon unexpectedly published readiness.");
		}
		if (daemon.process.exitCode !== null) return daemon.process.exitCode;
		if (daemon.process.signalCode !== null) return null;
		await tick();
	}
	throw new Error("Durability daemon neither failed nor became ready before its deadline.");
}

async function readDescriptor(
	root: string,
): Promise<Readonly<{ pid: number; url: string }> | undefined> {
	try {
		const decoded: unknown = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
		if (typeof decoded !== "object" || decoded === null) return undefined;
		const url = Reflect.get(decoded, "url");
		const pid = Reflect.get(decoded, "pid");
		return typeof url === "string" && Number.isSafeInteger(pid) && Number(pid) > 0
			? Object.freeze({ pid: Number(pid), url })
			: undefined;
	} catch (cause) {
		if (hasCode(cause, "ENOENT") || cause instanceof SyntaxError) return undefined;
		throw cause;
	}
}

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Port reservation did not produce a TCP address.");
	}
	await new Promise<void>((resolve, reject) =>
		server.close((cause) => (cause ? reject(cause) : resolve())),
	);
	return address.port;
}

function processExit(process: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		process.once("error", reject);
		process.once("close", (code) => resolve(code));
	});
}

async function waitForDurabilityRelease(root: string): Promise<void> {
	const paths = [join(root, "control-token"), join(root, "lock"), join(root, "runtime.json")];
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!(await anyPathExists(paths))) return;
		await tick();
	}
	throw new Error("Durability daemon retained active runtime files or its storage lock.");
}

async function clearCrashedRuntimeOwnership(root: string): Promise<void> {
	await Promise.all(
		["control-token", "lock", "runtime.json"].map((name) =>
			rm(join(root, name), { force: true, recursive: true }),
		),
	);
}

async function anyPathExists(paths: readonly string[]): Promise<boolean> {
	for (const path of paths) {
		try {
			await access(path);
			return true;
		} catch (cause) {
			if (!hasCode(cause, "ENOENT")) throw cause;
		}
	}
	return false;
}

async function nearestPackageRoot(fromFile: string): Promise<string> {
	let current = dirname(fromFile);
	const filesystemRoot = parse(current).root;
	while (true) {
		try {
			const manifest: unknown = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
			if (
				typeof manifest === "object" &&
				manifest !== null &&
				typeof Reflect.get(manifest, "name") === "string"
			) {
				return current;
			}
		} catch (cause) {
			if (!hasCode(cause, "ENOENT") && !(cause instanceof SyntaxError)) throw cause;
		}
		if (current === filesystemRoot) {
			throw new TypeError("Durability config module is not contained by a package.");
		}
		current = dirname(current);
	}
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

function supervisorModuleUrl(): URL {
	const extension = extname(fileURLToPath(import.meta.url));
	return new URL(
		extension === ".ts" ? "./durability-supervisor.ts" : "./durability-supervisor.js",
		import.meta.url,
	);
}

function hasCode(value: unknown, expected: string): boolean {
	return typeof value === "object" && value !== null && Reflect.get(value, "code") === expected;
}

function contractCase(name: string, run: () => Promise<void>): PluginContractCase {
	return Object.freeze({ name, run });
}

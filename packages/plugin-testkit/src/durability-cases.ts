import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceRecord } from "localhost2137";
import { connectRuntime, type RuntimeClient } from "localhost2137/client";
import { assertContract, assertContractEqual } from "./contract-assertions.js";
import type { PluginContractCase, PluginContractFixture } from "./contract-types.js";
import { capture, finishCaptured } from "./runtime-owner.js";
import { assertSelectedServiceIdentity } from "./service-identity.js";

const INSTANCE_ID = "dev";
const DAEMON_DEADLINE_MS = 10_000;

const contractProcessEnvironment: Readonly<{
	events: string;
	failUpdate: string;
	storage: string;
	version: string;
}> = Object.freeze({
	events: "LOCALHOST2137_CONTRACT_EVENTS",
	failUpdate: "LOCALHOST2137_CONTRACT_FAIL_UPDATE",
	storage: "LOCALHOST2137_CONTRACT_STORAGE",
	version: "LOCALHOST2137_CONTRACT_VERSION",
});

export function durabilityCases<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): readonly PluginContractCase[] {
	return Object.freeze([
		contractCase("update failure is recoverable", () => updateRecoveryCase(fixture)),
		contractCase("state persists across runtime restart", () => restartPersistenceCase(fixture)),
		contractCase("future stored state versions are rejected", () => futureVersionCase(fixture)),
		contractCase("state-version upgrades preserve data", () => stateUpgradeCase(fixture)),
	]);
}

async function restartPersistenceCase<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	const name = "state persists across runtime restart";
	await withDurabilityRoot(fixture, async (owner) => {
		const first = await owner.start(fixture.durability.versions.current, false, name);
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
		const second = await owner.start(fixture.durability.versions.current, false, name);
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
		const future = await owner.start(fixture.durability.versions.future, false, name);
		await future.stop();
		const exitCode = await owner.expectFailure(fixture.durability.versions.current, false);
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
		const old = await owner.start(fixture.durability.versions.old, false, name);
		await execute(old.client, fixture, fixture.durability.write);
		await old.stop();
		const current = await owner.start(fixture.durability.versions.current, false, name);
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
		const old = await owner.start(fixture.durability.versions.old, false, name);
		await execute(old.client, fixture, fixture.durability.write);
		await old.stop();
		const exitCode = await owner.expectFailure(fixture.durability.versions.current, true);
		assertContract(
			exitCode !== 0 || exitCode === null,
			name,
			"injected update failure started successfully",
		);
		const recovered = await owner.start(fixture.durability.versions.current, false, name);
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

interface RunningDaemon {
	readonly client: RuntimeClient;
	stop(): Promise<number | null>;
}

interface SpawnedDaemon {
	readonly closed: Promise<number | null>;
	readonly process: ChildProcess;
	stop(): Promise<number | null>;
}

interface DurabilityOwner {
	events(): Promise<readonly string[]>;
	expectFailure(version: number, failUpdate: boolean): Promise<number | null>;
	start(version: number, failUpdate: boolean, caseName: string): Promise<RunningDaemon>;
}

async function withDurabilityRoot<Services extends ServiceRecord, Value>(
	fixture: PluginContractFixture<Services>,
	work: (owner: DurabilityOwner) => Promise<Value>,
): Promise<Value> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-contract-durable-"));
	const eventsPath = join(root, "events.log");
	await writeFile(eventsPath, "", "utf8");
	const activeStops = new Set<() => Promise<number | null>>();
	const daemonCwd = await nearestPackageRoot(fileURLToPath(fixture.durability.configModule));
	const spawnOwned = async (version: number, failUpdate: boolean): Promise<SpawnedDaemon> => {
		await Promise.all([
			rm(join(root, "control-token"), { force: true }),
			rm(join(root, "runtime.json"), { force: true }),
		]);
		const port = await availablePort();
		const inheritedEnvironment = { ...process.env };
		delete inheritedEnvironment.LOCALHOST_CONTROL_TOKEN;
		const packageManager = pnpmCommand();
		const child = spawn(
			packageManager.command,
			[
				...packageManager.prefix,
				"exec",
				"localhost",
				"--config",
				fileURLToPath(fixture.durability.configModule),
				"dev",
				"--port",
				String(port),
			],
			{
				cwd: daemonCwd,
				detached: process.platform !== "win32",
				env: {
					...inheritedEnvironment,
					[contractProcessEnvironment.events]: eventsPath,
					[contractProcessEnvironment.failUpdate]: failUpdate ? "1" : "0",
					[contractProcessEnvironment.storage]: root,
					[contractProcessEnvironment.version]: String(version),
				},
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		const closed = processExit(child);
		let stopPromise: Promise<number | null> | undefined;
		const stop = (): Promise<number | null> => {
			if (!stopPromise) {
				stopPromise = stopProcessTree(child, closed);
				void stopPromise.then(
					() => activeStops.delete(stop),
					() => activeStops.delete(stop),
				);
			}
			return stopPromise;
		};
		activeStops.add(stop);
		return Object.freeze({ closed, process: child, stop });
	};
	const owner: DurabilityOwner = Object.freeze({
		events: async () =>
			Object.freeze((await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)),
		expectFailure: async (version: number, failUpdate: boolean) => {
			const daemon = await spawnOwned(version, failUpdate);
			try {
				return await waitForFailure(root, daemon);
			} finally {
				await daemon.stop();
			}
		},
		start: async (version: number, failUpdate: boolean, caseName: string) => {
			const daemon = await spawnOwned(version, failUpdate);
			try {
				const descriptor = await waitForDescriptor(root, daemon);
				const token = (await readFile(join(root, "control-token"), "utf8")).trim();
				const client = connectRuntime({ token, url: descriptor.url });
				await assertSelectedServiceIdentity(client, INSTANCE_ID, fixture, caseName, version);
				return Object.freeze({ client, stop: daemon.stop });
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

async function waitForDescriptor(
	root: string,
	daemon: SpawnedDaemon,
): Promise<Readonly<{ url: string }>> {
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

async function readDescriptor(root: string): Promise<Readonly<{ url: string }> | undefined> {
	try {
		const decoded: unknown = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
		if (typeof decoded !== "object" || decoded === null) return undefined;
		const url = Reflect.get(decoded, "url");
		return typeof url === "string" ? Object.freeze({ url }) : undefined;
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

async function stopProcessTree(
	child: ChildProcess,
	closed: Promise<number | null>,
): Promise<number | null> {
	const processGroup = process.platform !== "win32" && child.pid ? -child.pid : undefined;
	if (processGroup !== undefined) signalProcessGroup(processGroup, "SIGINT");
	else if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
	try {
		const exitCode = await withinCleanupDeadline(closed);
		await tick();
		await tick();
		return exitCode;
	} catch (cause) {
		if (!(cause instanceof ProcessCleanupTimeoutError)) throw cause;
		if (processGroup !== undefined) signalProcessGroup(processGroup, "SIGKILL");
		else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		return withinCleanupDeadline(closed);
	}
}

class ProcessCleanupTimeoutError extends Error {
	constructor() {
		super("Durability process exceeded its cleanup deadline.");
		this.name = "ProcessCleanupTimeoutError";
	}
}

async function withinCleanupDeadline<Value>(promise: Promise<Value>): Promise<Value> {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new ProcessCleanupTimeoutError()), 2_000);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function signalProcessGroup(processGroup: number, signal: NodeJS.Signals): void {
	try {
		process.kill(processGroup, signal);
	} catch (cause) {
		if (!hasCode(cause, "ESRCH")) throw cause;
	}
}

function pnpmCommand(): Readonly<{ command: string; prefix: readonly string[] }> {
	const npmExecPath = process.env.npm_execpath;
	if (
		npmExecPath &&
		isAbsolute(npmExecPath) &&
		/^pnpm(?:\.c?js|\.mjs)?$/i.test(basename(npmExecPath))
	) {
		return Object.freeze({ command: process.execPath, prefix: Object.freeze([npmExecPath]) });
	}
	return Object.freeze({
		command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
		prefix: Object.freeze([]),
	});
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

function hasCode(value: unknown, expected: string): boolean {
	return typeof value === "object" && value !== null && Reflect.get(value, "code") === expected;
}

function contractCase(name: string, run: () => Promise<void>): PluginContractCase {
	return Object.freeze({ name, run });
}

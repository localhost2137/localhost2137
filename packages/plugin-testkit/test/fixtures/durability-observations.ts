import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectRuntime } from "localhost2137/client";

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const configPath = fileURLToPath(new URL("./durability-daemon.config.ts", import.meta.url));
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export async function observeRestartPersistence() {
	return withDurabilityRoot(async (fixture) => {
		const first = await startDaemon(fixture, 1);
		await first.client.executeOperation("dev", "durable", "setValue", { value: 41 });
		await first.stop();
		const second = await startDaemon(fixture, 1);
		const value = await readValue(second);
		const stopCode = await second.stop();
		return observation({ stopCode, value }, { stopCode: null, value: 41 });
	});
}

export async function observeFutureVersionRejection() {
	return withDurabilityRoot(async (fixture) => {
		const current = await startDaemon(fixture, 2);
		await current.stop();
		const failureCode = await startFailure(fixture, 1);
		return observation(failureCode !== null && failureCode !== 0, true);
	});
}

export async function observeStateUpgrade() {
	return withDurabilityRoot(async (fixture) => {
		const first = await startDaemon(fixture, 1);
		await first.client.executeOperation("dev", "durable", "setValue", { value: 41 });
		await first.stop();
		const upgraded = await startDaemon(fixture, 2);
		const value = await readValue(upgraded);
		await upgraded.stop();
		return observation(
			{ events: await events(fixture.eventsPath), value },
			{ events: ["update:1:2"], value: 41 },
		);
	});
}

export async function observeUpdateFailureRecovery() {
	return withDurabilityRoot(async (fixture) => {
		const first = await startDaemon(fixture, 1);
		await first.client.executeOperation("dev", "durable", "setValue", { value: 41 });
		await first.stop();
		const failureCode = await startFailure(fixture, 2, true);
		const recovered = await startDaemon(fixture, 2);
		const value = await readValue(recovered);
		await recovered.stop();
		return observation(
			{
				events: await events(fixture.eventsPath),
				failed: failureCode !== null && failureCode !== 0,
				value,
			},
			{ events: ["update:1:2", "update:1:2"], failed: true, value: 41 },
		);
	});
}

interface DurabilityFixture {
	readonly activeStops: Set<() => Promise<number | null>>;
	readonly eventsPath: string;
	readonly root: string;
}

interface RunningDaemon {
	readonly client: ReturnType<typeof connectRuntime>;
	stop(): Promise<number | null>;
}

interface SpawnedDaemon {
	readonly closed: Promise<number | null>;
	readonly output: Readonly<{ read(): string }>;
	readonly process: ChildProcess;
	stop(): Promise<number | null>;
}

async function startDaemon(
	fixture: DurabilityFixture,
	version: number,
	failUpdate: boolean = false,
): Promise<RunningDaemon> {
	const daemon = await spawnDaemon(fixture, version, failUpdate);
	const descriptor = await waitForDescriptor(fixture.root, daemon.process, daemon.output);
	const token = (await readFile(join(fixture.root, "control-token"), "utf8")).trim();
	return Object.freeze({
		client: connectRuntime({ token, url: descriptor.url }),
		stop: daemon.stop,
	});
}

async function startFailure(
	fixture: DurabilityFixture,
	version: number,
	failUpdate: boolean = false,
): Promise<number | null> {
	const daemon = await spawnDaemon(fixture, version, failUpdate);
	return await daemon.closed;
}

async function spawnDaemon(
	fixture: DurabilityFixture,
	version: number,
	failUpdate: boolean,
): Promise<SpawnedDaemon> {
	await Promise.all([
		rm(join(fixture.root, "control-token"), { force: true }),
		rm(join(fixture.root, "runtime.json"), { force: true }),
	]);
	const port = await availablePort();
	const child = spawn(
		pnpmExecutable,
		["exec", "localhost", "--config", configPath, "dev", "--port", String(port)],
		{
			cwd: packageDirectory,
			env: {
				...process.env,
				LOCALHOST2137_CONTRACT_EVENTS: fixture.eventsPath,
				LOCALHOST2137_CONTRACT_FAIL_UPDATE: failUpdate ? "1" : "0",
				LOCALHOST2137_CONTRACT_STORAGE: fixture.root,
				LOCALHOST2137_CONTRACT_VERSION: String(version),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const closed = processExit(child);
	const output = collectOutput(child);
	let stopPromise: Promise<number | null> | undefined;
	const stop = (): Promise<number | null> => {
		if (!stopPromise) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
			stopPromise = closed;
		}
		return stopPromise;
	};
	fixture.activeStops.add(stop);
	void closed.then(
		() => fixture.activeStops.delete(stop),
		() => fixture.activeStops.delete(stop),
	);
	return Object.freeze({ closed, output, process: child, stop });
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

async function waitForDescriptor(
	root: string,
	process: ChildProcess,
	output: Readonly<{ read(): string }>,
): Promise<Readonly<{ url: string }>> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const decoded: unknown = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
			if (typeof decoded === "object" && decoded !== null) {
				const url = Reflect.get(decoded, "url");
				if (typeof url === "string") return Object.freeze({ url });
			}
		} catch (cause) {
			if (!hasCode(cause, "ENOENT")) throw cause;
		}
		if (process.exitCode !== null) {
			throw new Error(`Durability daemon exited before ready.\n${output.read()}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	process.kill("SIGINT");
	throw new Error(`Durability daemon did not publish readiness.\n${output.read()}`);
}

function collectOutput(process: ChildProcess): Readonly<{ read(): string }> {
	const chunks: Buffer[] = [];
	process.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
	process.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
	return Object.freeze({ read: () => Buffer.concat(chunks).toString("utf8") });
}

function processExit(process: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		process.once("error", reject);
		process.once("close", (code) => resolve(code));
	});
}

async function readValue(running: RunningDaemon): Promise<number> {
	const result = await running.client.executeOperation("dev", "durable", "readValue", {});
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		throw new TypeError("Durability read output must be an object.");
	}
	const value = Reflect.get(result, "value");
	if (typeof value !== "number") throw new TypeError("Durability read output has no value.");
	return value;
}

async function events(path: string): Promise<readonly string[]> {
	return (await readFile(path, "utf8")).split("\n").filter(Boolean);
}

async function withDurabilityRoot<Value>(
	work: (fixture: DurabilityFixture) => Promise<Value>,
): Promise<Value> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-contract-durable-"));
	const fixture = Object.freeze({
		activeStops: new Set<() => Promise<number | null>>(),
		eventsPath: join(root, "events.log"),
		root,
	});
	await writeFile(fixture.eventsPath, "", "utf8");
	const outcome = await work(fixture).then(
		(value) => Object.freeze({ status: "fulfilled" as const, value }),
		(reason: unknown) => Object.freeze({ reason, status: "rejected" as const }),
	);
	const cleanupFailures: unknown[] = [];
	for (const result of await Promise.allSettled([...fixture.activeStops].map((stop) => stop()))) {
		if (result.status === "rejected") cleanupFailures.push(result.reason);
	}
	try {
		await rm(root, { force: true, recursive: true });
	} catch (cause) {
		cleanupFailures.push(cause);
	}
	if (outcome.status === "rejected" && cleanupFailures.length > 0) {
		throw new AggregateError(
			[outcome.reason, ...cleanupFailures],
			"Durability contract probe and cleanup failed.",
		);
	}
	if (outcome.status === "rejected") throw outcome.reason;
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, "Durability contract probe cleanup failed.");
	}
	return outcome.value;
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}

function observation(actual: unknown, expected: unknown) {
	return Object.freeze({ actual, expected });
}

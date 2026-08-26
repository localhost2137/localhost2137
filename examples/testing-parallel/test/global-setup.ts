import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRuntime } from "localhost2137/testing";
import type { TestProject } from "vitest/node";
import { config } from "../src/config.js";
import type { WorkerRuntimeHarness } from "./runtime-connection.js";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const barrierDirectory = await mkdtemp(join(tmpdir(), "localhost2137-vitest-barrier-"));
	let runtime: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
	try {
		const ownedRuntime = await createTestRuntime({ config, port: 0, storage: "temporary" });
		runtime = ownedRuntime;
		const harness: WorkerRuntimeHarness = Object.freeze({
			barrier: Object.freeze({ directory: barrierDirectory, participants: 4 }),
			connection: ownedRuntime.connection,
		});
		project.provide("localhost2137", harness);
		return () => closeOwnedResources(ownedRuntime, barrierDirectory);
	} catch (cause) {
		const failures = await cleanupFailures(runtime, barrierDirectory);
		if (failures.length > 0) {
			throw new AggregateError([cause, ...failures], "Parallel example setup and cleanup failed.");
		}
		throw cause;
	}
}

async function closeOwnedResources(
	runtime: Awaited<ReturnType<typeof createTestRuntime>>,
	barrierDirectory: string,
): Promise<void> {
	const failures = await cleanupFailures(runtime, barrierDirectory);
	if (failures.length > 0) throw new AggregateError(failures, "Parallel example cleanup failed.");
}

async function cleanupFailures(
	runtime: Awaited<ReturnType<typeof createTestRuntime>> | undefined,
	barrierDirectory: string,
): Promise<unknown[]> {
	const failures: unknown[] = [];
	await runtime?.close().catch((cause: unknown) => failures.push(cause));
	await rm(barrierDirectory, { force: true, recursive: true }).catch((cause: unknown) =>
		failures.push(cause),
	);
	return failures;
}

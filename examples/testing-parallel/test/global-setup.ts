import { createTestRuntime } from "localhost2137/testing";
import type { TestProject } from "vitest/node";
import { config } from "../src/config.js";
import type { WorkerRuntimeConnection } from "./runtime-connection.js";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	try {
		const connection: WorkerRuntimeConnection = runtime.connection;
		project.provide("localhost2137", connection);
		return () => runtime.close();
	} catch (cause) {
		await runtime.close();
		throw cause;
	}
}

import { randomUUID } from "node:crypto";
import { connectRuntime } from "localhost2137/client";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { arriveAtBarrier } from "./barrier.js";
import "./runtime-connection.js";

export function defineWorkerContract(label: string, increment: number): void {
	describe(label, () => {
		const harness = inject("localhost2137");
		const runtime = connectRuntime(harness.connection);
		const instanceId = `parallel-${randomUUID()}`;
		let created = false;

		beforeAll(async () => {
			await runtime.createInstance({ id: instanceId, persistence: "ephemeral" });
			created = true;
		});

		afterAll(async () => {
			if (created) await runtime.destroyInstance(instanceId);
		});

		it("owns isolated state on the shared runtime", async () => {
			await expect(runtime.executeOperation(instanceId, "counter", "read", {})).resolves.toEqual({
				value: 0,
			});
			await expect(
				runtime.executeOperation(instanceId, "counter", "increment", { by: increment }),
			).resolves.toEqual({ value: increment });
			await arriveAtBarrier(
				harness.barrier.directory,
				label.split(" ")[0] ?? label,
				harness.barrier.participants,
			);
			await expect(runtime.executeOperation(instanceId, "counter", "read", {})).resolves.toEqual({
				value: increment,
			});
			await runtime.idle(instanceId);
		});
	});
}

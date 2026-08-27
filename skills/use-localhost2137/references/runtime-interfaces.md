# Runtime interfaces

Read only the section that matches the requested workflow. Confirm signatures against the installed `localhost2137` version before editing another project.

## In-process tests

This checked test owns the runtime, one explicitly seeded instance, and the application process. The
child inherits the harness process environment with plugin connection values overlaid by
`instance.env`:

```ts title="test/read-workspace.test.ts"
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestRuntime } from "localhost2137/testing";
import { expect, it } from "vitest";
import config from "../localhost.config.js";

const execFileAsync = promisify(execFile);

it("reads one seeded world through the provider-shaped HTTP API", async () => {
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });

	try {
		const instance = await runtime.createInstance({ seed: true });
		try {
			const appPath = fileURLToPath(new URL("../src/read-workspace.ts", import.meta.url));
			const { stderr, stdout } = await execFileAsync(process.execPath, [appPath], {
				env: { ...process.env, ...instance.env },
			});

			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toEqual([
				{ id: "U000000", name: "localhost2137-bot" },
				{ id: "U_ADA", name: "Ada" },
			]);
		} finally {
			await instance.destroy();
		}
	} finally {
		await runtime.close();
	}
});
```

The test runtime owns one loopback server on an OS-assigned port and temporary storage. Its instances are path-isolated worlds. The typed instance handle contains:

- one property per configured service, with typed operation methods and `connection` values;
- `clock.status()` and `clock.advance(duration)`;
- merged app-facing `env`;
- `idle()`, `seed()`, `reset({ seed? })`, and `destroy()`.

Seeding is explicit. `createInstance()` and `reset()` default to an empty world.

## Developer daemon and generated CLI

These runtime commands exist in the current public CLI:

```text
localhost dev
localhost describe [service] --json
localhost exec <service> --help
localhost exec <service> <operation> [generated flags] --json
localhost instance create <id> [--seed]
localhost instance list [--json]
localhost instance reset <id> [--seed]
localhost instance destroy <id>
localhost seed [--instance <id>]
localhost env [--instance <id>] --format json
localhost run [--instance <id>] -- <command...>
localhost logs [service] [--instance <id>] --json
localhost clock status [--instance <id>] --json
localhost clock advance <duration> [--instance <id>] --json
localhost doctor --json
```

Use `describe` and generated `exec` help as the authority for the configured plugin's operation inventory. Simple Zod object inputs become flags; other inputs use the generated `--input-json` path. JSON mode is for machine consumption.

The default instance is `dev`. Public emulator URLs are path-scoped as `/{instance}/{service}/*`. The control API is separate under `/_/v1/*` and requires the runtime bearer token. Do not expose that token to application or browser code.

Clock durations are positive whole values with one of `ms`, `s`, `m`, `h`, `d`, or `w`. There is no calendar-month unit. Advance time only when the installed plugin documents time-derived behavior.

## Remote and parallel tests

Use `connectRuntime` from `localhost2137/client`. Keep this checked ownership helper intact when a
worker owns an instance on a runtime started by another process:

```ts title="test/owned-instance.ts"
import { ControlApiError, type RuntimeClient } from "localhost2137/client";

type InstanceOwnerClient = Pick<RuntimeClient, "createInstance" | "destroyInstance">;

type Outcome<Value> =
	| Readonly<{ ok: true; value: Value }>
	| Readonly<{ cause: unknown; ok: false }>;

/** Own one known worker instance ID without deleting an authoritative conflict. */
export async function withOwnedInstance<Value>(
	runtime: InstanceOwnerClient,
	instanceId: string,
	use: () => Promise<Value>,
): Promise<Value> {
	try {
		await runtime.createInstance({ id: instanceId, persistence: "ephemeral" });
	} catch (cause) {
		if (cause instanceof ControlApiError) throw cause;
		return finishOwnership(runtime, instanceId, { cause, ok: false });
	}

	let primary: Outcome<Value>;
	try {
		primary = { ok: true, value: await use() };
	} catch (cause) {
		primary = { cause, ok: false };
	}
	return finishOwnership(runtime, instanceId, primary);
}

async function finishOwnership<Value>(
	runtime: InstanceOwnerClient,
	instanceId: string,
	primary: Outcome<Value>,
): Promise<Value> {
	const cleanup = await destroyIfPresent(runtime, instanceId);
	if (!primary.ok) {
		if (!cleanup.ok) {
			throw new AggregateError(
				[primary.cause, cleanup.cause],
				`Worker instance ${JSON.stringify(instanceId)} failed and cleanup also failed.`,
				{ cause: primary.cause },
			);
		}
		throw primary.cause;
	}
	if (!cleanup.ok) throw cleanup.cause;
	return primary.value;
}

async function destroyIfPresent(
	runtime: InstanceOwnerClient,
	instanceId: string,
): Promise<Outcome<void>> {
	try {
		await runtime.destroyInstance(instanceId);
		return { ok: true, value: undefined };
	} catch (cause) {
		if (cause instanceof ControlApiError && cause.code === "INSTANCE_NOT_FOUND") {
			return { ok: true, value: undefined };
		}
		return { cause, ok: false };
	}
}
```

The checked worker uses the helper with a collision-resistant ID and an introspection-driven remote
client:

```ts title="test/worker-contract.ts"
import { randomUUID } from "node:crypto";
import { connectRuntime } from "localhost2137/client";
import { describe, expect, inject, it } from "vitest";
import { arriveAtBarrier } from "./barrier.js";
import { withOwnedInstance } from "./owned-instance.js";
import "./runtime-connection.js";

export function defineWorkerContract(label: string, increment: number): void {
	describe(label, () => {
		const harness = inject("localhost2137");
		const runtime = connectRuntime(harness.connection);
		const instanceId = `parallel-${randomUUID()}`;

		it("owns isolated state on the shared runtime", async () => {
			await withOwnedInstance(runtime, instanceId, async () => {
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
			});
		});
	});
}
```

Implement or reuse `withOwnedInstance` with these ownership rules:

- Select the collision-resistant ID before create. It is the only handle available if the response
  is lost.
- A create `ControlApiError` is an authoritative rejection. Do not run the scenario or destroy that
  ID; an `INSTANCE_CONFLICT` can identify another owner's world.
- A transport or protocol create failure is uncertain. Reconcile the caller-selected ID by
  attempting destroy: `INSTANCE_NOT_FOUND` means create did not commit, while successful destroy
  removes the world that did commit. Preserve the original create failure either way.
- After successful create, always attempt destroy. Ignore only `INSTANCE_NOT_FOUND`. If the scenario
  or uncertain create already failed and cleanup also fails, throw an `AggregateError` with the
  primary failure first and as `cause`, followed by cleanup.

This is the same ownership contract as the maintained
[parallel-worker helper](https://localhost2137.dev/testing#share-one-runtime-across-worker-processes).
The remote client is intentionally untyped and introspection-driven. Use it when another process
owns the runtime, particularly test-runner global setup. Keep the URL and token in the test harness;
never close the shared runtime from a worker.

Instances isolate emulator state and service storage. They do not create distinct plugin configurations or application callback URLs. Before running callbacks, events, or webhooks in parallel, confirm how the installed plugin routes them and how the application associates a callback with an instance. Never promise application callback isolation from instance isolation alone.

## Application boundary

Connection metadata is plugin-owned. Inspect its exact `values` and `env` fields in the installed plugin types. Prefer passing typed `connection` values directly in tests. Use environment injection when exercising the application's real startup path.

Operations are the privileged control plane for arranging and inspecting emulator state. The public emulated API is the application-facing interface. Keeping those roles separate prevents tests from replacing the behavior they intend to verify.

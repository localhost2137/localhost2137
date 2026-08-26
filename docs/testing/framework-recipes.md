# Test framework recipes

localhost2137 has no framework-specific runtime. Tests either own an in-process
`createTestRuntime()` directly or pass its serializable connection to workers, which use
`connectRuntime()`. Ownership remains explicit in both forms:

1. one coordinator owns and closes the runtime;
2. one file or worker creates and destroys each instance it uses;
3. instance cleanup runs before runtime cleanup, including after failed assertions.

## Per-file typed setup

Use the typed API when the tests and imported config run in the same process:

```ts
import type { InstanceHandle } from "localhost2137";
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import { afterAll, beforeAll } from "vitest";
import config from "../localhost.config.js";

let runtime: TestRuntime<typeof config.services> | undefined;
let instance: InstanceHandle<typeof config.services> | undefined;

beforeAll(async () => {
	runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	instance = await runtime.createInstance({ seed: true });
});

afterAll(async () => {
	const failures: unknown[] = [];
	await instance?.destroy().catch((cause: unknown) => failures.push(cause));
	await runtime?.close().catch((cause: unknown) => failures.push(cause));
	if (failures.length > 0) throw new AggregateError(failures, "Instance cleanup failed.");
});
```

Prefer `try/finally` inside an individual test when the instance belongs to that test. Keep the
runtime owner at the widest useful scope, and do not hide it in an import-time singleton.

## Vitest workers

The executable [`examples/testing-parallel`](../../examples/testing-parallel/README.md) is the
canonical recipe. Global setup owns one runtime and passes only its frozen `{ url, token }`
connection through `project.provide`. Four fork workers connect with `localhost2137/client`; each
creates a random ephemeral instance in `beforeAll` and destroys it in `afterAll`.

This split is deliberate: workers use the untyped, introspection-driven remote client because the
typed instance handle cannot cross a process boundary. Keep typed application helpers above the
client if a project wants typed remote operations.

## Playwright worker fixture

Playwright global setup can own one runtime for the run and return its teardown. Pass the connection
to Node-side workers through a process-only channel, then create one instance per worker:

```ts
// global-setup.ts
import { createTestRuntime } from "localhost2137/testing";
import config from "./localhost.config.js";

export default async function globalSetup() {
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	process.env.LOCALHOST2137_TEST_CONNECTION = JSON.stringify(runtime.connection);
	return async () => {
		delete process.env.LOCALHOST2137_TEST_CONNECTION;
		await runtime.close();
	};
}
```

```ts
// test-connection.ts — import this before application modules in every worker
const encoded = process.env.LOCALHOST2137_TEST_CONNECTION;
delete process.env.LOCALHOST2137_TEST_CONNECTION;
if (!encoded) throw new Error("localhost2137 global setup did not provide a connection.");

const decoded: unknown = JSON.parse(encoded);
if (typeof decoded !== "object" || decoded === null) {
	throw new Error("localhost2137 test connection is invalid.");
}
const token = Reflect.get(decoded, "token");
const url = Reflect.get(decoded, "url");
if (typeof token !== "string" || typeof url !== "string") {
	throw new Error("localhost2137 test connection is incomplete.");
}

export const localhostTestConnection = Object.freeze({ token, url });
```

```ts
// fixtures.ts — the only test entry point; it imports the holder first
import { randomUUID } from "node:crypto";
import { connectRuntime, type RuntimeClient } from "localhost2137/client";
import { test as base } from "@playwright/test";
import { localhostTestConnection } from "./test-connection.js";

type WorkerFixtures = { localhost: { client: RuntimeClient; instanceId: string } };

export const test = base.extend<{}, WorkerFixtures>({
	localhost: [
		async ({}, use) => {
			const client = connectRuntime(localhostTestConnection);
			const instanceId = `playwright-${randomUUID()}`;
			await client.createInstance({ id: instanceId, persistence: "ephemeral" });
			try {
				await use({ client, instanceId });
			} finally {
				await client.destroyInstance(instanceId);
			}
		},
		{ scope: "worker" },
	],
});
```

The test-only holder deletes the worker's environment copy before application modules load and keeps
the token only in its module closure. Make the custom fixture the first import in each test. Start
application subprocesses only afterward and pass a sanitized environment. The Playwright owner
process necessarily retains its own environment copy until it has spawned workers and teardown runs;
do not import application code or launch application subprocesses from that owner. Never expose the
token through `page.evaluate`, a browser environment variable, a trace, or a screenshot. Browser code
receives only a plugin's public connection values.

## Jest workers

Jest global setup and teardown follow the same remote-client split. Global setup owns the runtime,
stores the connection in a process environment variable inherited by workers, and retains the
runtime only for global teardown. Test files create unique instances through `connectRuntime` and
destroy them in `afterAll`.

```ts
// jest.global-setup.ts
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import config from "./localhost.config.js";

declare global {
	var localhost2137Owner: TestRuntime<typeof config.services> | undefined;
}

export default async function setup() {
	const runtime = await createTestRuntime({ config, port: 0, storage: "temporary" });
	globalThis.localhost2137Owner = runtime;
	process.env.LOCALHOST2137_TEST_CONNECTION = JSON.stringify(runtime.connection);
}
```

```ts
// jest.global-teardown.ts
export default async function teardown() {
	try {
		await globalThis.localhost2137Owner?.close();
	} finally {
		delete process.env.LOCALHOST2137_TEST_CONNECTION;
		globalThis.localhost2137Owner = undefined;
	}
}
```

Configure the `test-connection.ts` holder shown above as a Jest `setupFiles` entry, so every worker
parses, validates, and deletes its inherited environment copy before the test framework or
application modules load. Test files import the holder's frozen value, create unique instances, and
destroy them in `afterAll`. Launch application subprocesses only after this bootstrap and pass an
explicit environment that does not contain `LOCALHOST2137_TEST_CONNECTION`.

The Jest owner process retains its own environment copy until global teardown because workers still
need to inherit it. Keep application code and subprocesses out of that process. If a Jest runner
cannot preserve the global-setup owner until global teardown, put ownership in a small dedicated Node
process and communicate over its private IPC channel; do not make workers race to own a shared
descriptor or storage directory.

## Token and failure handling

- Treat the control token as a capability secret even on loopback. Do not log it, snapshot it, add
  it to test reports, persist it in an artifact, or pass it to browser code.
- Delete token-bearing environment handoffs in the earliest worker bootstrap. Retain the parsed value
  only inside test harness code, and sanitize the environment of every application child process.
- Use only the OS-assigned loopback URL returned by the owner. Never rewrite it to a LAN interface.
- Use collision-resistant instance IDs for remote workers; never derive correctness from a
  framework-specific worker number alone.
- Use `Promise.allSettled` when an owner may need to destroy several instances, then close the
  runtime and report every cleanup failure.
- A cleanup failure retains its temporary path in `TestRuntimeCleanupError`; report that path for
  diagnosis rather than deleting a broader directory.

# Runtime interfaces

Read only the section that matches the requested workflow. Confirm signatures against the installed `localhost2137` version before editing another project.

## In-process tests

Import `createTestRuntime` from `localhost2137/testing` and pass a complete typed config:

```ts
const runtime = await createTestRuntime({
  config,
  port: 0,
  storage: "temporary",
});

try {
  const instance = await runtime.createInstance({ seed: false });
  try {
    // Arrange and inspect through instance.<service> operation methods.
    // Pass instance.<service>.connection to the application under test.
    // Await instance.idle() after plugin-owned asynchronous delivery work.
  } finally {
    await instance.destroy();
  }
} finally {
  await runtime.close();
}
```

The test runtime owns one loopback server on an OS-assigned port and temporary storage. Its instances are path-isolated worlds. The typed instance handle contains:

- one property per configured service, with typed operation methods and `connection` values;
- `clock.status()` and `clock.advance(duration)`;
- merged app-facing `env`;
- `idle()`, `seed()`, `reset({ seed? })`, and `destroy()`.

Seeding is explicit. `createInstance()` and `reset()` default to an empty world.

## Developer daemon and generated CLI

These runtime commands exist in the current public CLI:

```sh
localhost dev
localhost describe [service] --json
localhost exec <service> --help
localhost exec <service> <operation> [generated flags] --json
localhost instance create <id> [--seed]
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

Import `connectRuntime` from `localhost2137/client`:

```ts
const runtime = connectRuntime({ url, token });
await runtime.createInstance({
  id: instanceId,
  persistence: "ephemeral",
  seed: false,
});

try {
  await runtime.executeOperation(instanceId, serviceKey, operationKey, input);
  await runtime.idle(instanceId);
} finally {
  await runtime.destroyInstance(instanceId);
}
```

The remote client is intentionally untyped and introspection-driven. Use it when another process owns the runtime, particularly test-runner global setup. Keep the URL and token in the test harness, allocate collision-resistant instance IDs, and destroy only instances owned by that worker.

## Application boundary

Connection metadata is plugin-owned. Inspect its exact `values` and `env` fields in the installed plugin types. Prefer passing typed `connection` values directly in tests. Use environment injection when exercising the application's real startup path.

Operations are the privileged control plane for arranging and inspecting emulator state. The public emulated API is the application-facing interface. Keeping those roles separate prevents tests from replacing the behavior they intend to verify.

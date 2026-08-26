---
name: use-localhost2137
description: Integrate and test applications against stateful service-emulator plugins running on localhost2137. Use when Codex needs to configure installed plugins in localhost.config.ts, wire an application's existing SDK or service interface to a local emulator, arrange and inspect emulator state through operations, create isolated integration tests, drive virtual time, use the daemon or control client, or diagnose an application-to-emulator workflow.
---

# Use localhost2137

Treat localhost2137 as a runtime for emulator plugins. Let the installed plugin define the service behavior, configuration, connection values, operations, and compatibility boundary.

## Ground the work

1. Inspect the project's package manager, module format, test runner, existing service integration, and `localhost.config.ts` before editing.
2. Inspect the installed plugin's package exports, types, examples, and compatibility notes. If a runtime is already running, use its generated help or JSON description to confirm operation names and inputs.
3. Identify the application's existing provider boundary: official SDK, HTTP client, webhook handler, adapter, or equivalent. Preserve it unless the user explicitly wants to redesign production code.
4. State any unsupported behavior that affects the requested scenario. Never infer one plugin's capabilities from another plugin.

Do not invent plugin packages, configuration fields, operations, SDK adapters, CLI commands, or compatibility claims. Verify them in the installed version.

## Build the smallest useful integration

1. Add the configured plugin under a meaningful `services` key. Treat that key as the service's route, storage, control, and typed-handle identity.
2. Pass the selected instance's plugin-owned `connection` values to the application. Prefer the application's normal provider SDK or interface; use a plugin-supplied adapter only when that SDK requires it.
3. Use plugin operations to arrange and inspect the local world. Exercise the behavior under test through the application's normal interface.
4. Keep fake local credentials separate from real credentials. Do not copy a local token or control token into production configuration.
5. Avoid application branches that reimplement provider behavior merely because the endpoint is local.

## Choose an ownership model

- For an in-process integration test, create one explicit test runtime, create an isolated instance for the test, and clean up both the application and instance on every failure path.
- For parallel workers, let one owner process hold the test runtime. Give workers only its loopback URL and control token, then create one unique ephemeral instance per worker through `localhost2137/client`.
- For a developer session, run the daemon and use generated discovery rather than memorized service commands. Use `localhost run --` only when the application should receive the instance's connection environment.

Read [runtime-interfaces.md](references/runtime-interfaces.md) when choosing or implementing one of these modes.

## Exercise a scenario

Use this sequence unless the test has a clear reason to differ:

1. Create an empty isolated instance, or request configured seed data explicitly.
2. Arrange service state through typed plugin operations.
3. Start or invoke the application through its normal service-facing interface.
4. Trigger the relevant behavior through an operation, public emulated API, or explicit clock advancement.
5. Await `instance.idle()` before asserting work delivered asynchronously by plugins.
6. Observe results through a public application output, a plugin inspection operation, or the provider-compatible API.
7. Destroy the instance in `finally`; close the runtime from the scope that created it.

Cover the failure or boundary behavior that matters to the application, not just a successful request. Keep each test world independent; never depend on test order or shared `dev` state.

## Diagnose without bypassing the product

- Confirm the selected instance, service key, connection URL, and operation input first.
- Use runtime logs and structured errors without exposing the control token or configured credentials.
- Distinguish an application bug, unsupported plugin behavior, and runtime failure before changing code.
- If the plugin lacks required behavior, report the exact compatibility gap. Do not patch around it with test-only responses that make the scenario falsely pass.
- Do not import localhost2137 source internals or reach into plugin persistence from application tests.

## Verify and explain

Run the narrow scenario, the affected project's typecheck, and its relevant test suite. Verify that cleanup succeeds and that no daemon, port, or temporary state is leaked.

Tell the human:

- which application boundary now points at localhost2137;
- how the test arranges, triggers, and observes the local world;
- the exact command used to verify it;
- the installed plugin behavior the scenario depends on;
- any relevant compatibility limit or unverified assumption.

Use plain language. Describe demonstrated behavior, not product promises.

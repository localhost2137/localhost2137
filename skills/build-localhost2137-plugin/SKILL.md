---
name: build-localhost2137-plugin
description: Author, extend, or review a stateful external-service emulator plugin for localhost2137 through its public Hono, Zod, operation, lifecycle, connection, persistence, and plugin-testkit contracts. Use when designing a plugin, adding compatible API behavior or control operations, implementing state migrations or durable delivery, responding to virtual time, creating a contract fixture, or improving an existing plugin without coupling it to runtime internals.
---

# Build a localhost2137 plugin

Build an executable emulator with an explicit supported surface. Keep service behavior inside the plugin and runtime concerns inside localhost2137.

## Establish the boundary

Before editing:

1. Inspect the installed `localhost2137` and `@localhost2137/plugin-testkit` versions, exports, and public types.
2. Identify the application or SDK behavior that makes the plugin useful. Define the smallest coherent compatibility slice and its deliberate omissions.
3. Inspect existing domain, persistence, API, operation, lifecycle, and test ownership. Add a module only when it has one clear reason to change.
4. Read [public-contract.md](references/public-contract.md) for exact authoring capabilities. Read [contract-testing.md](references/contract-testing.md) before creating or changing the shared contract fixture.

Do not import runtime source internals. If the public contract cannot express required behavior, explain the missing capability instead of creating a hidden dependency or service-specific kernel workaround.

For a review or diagnosis request, inspect and report without changing files unless the user also requests implementation.

## Keep ownership explicit

The plugin owns:

- provider-compatible HTTP behavior and response mapping;
- configuration and optional seed schemas;
- domain rules and provider-shaped identities, with deterministic generation only when it is a deliberate compatibility choice;
- persistence, transactions, schema, and migrations;
- control operations and connection metadata;
- outbound event, webhook, or retry semantics.

The runtime owns route mounting, isolated storage locations, instance lifecycle, operation adapters, tracked transport, task draining, virtual clock delivery, and control-plane authentication.

Keep these layers separate:

- Make public API routes and control operations call the same domain services or repositories. Never make them call each other.
- Keep persistence rows, domain records, compatible API payloads, and operation DTOs distinct when their meanings differ.
- Keep adapter code to parse, call domain behavior, and map a response.
- Avoid generic `utils`, `helpers`, or a plugin-wide manager. Name shared code after the domain rule it owns.

## Implement one vertical behavior at a time

For each behavior:

1. Add or update the domain rule and persistence transaction.
2. Expose the application-facing path through the plain Hono route table when required.
3. Expose only useful arrangement or inspection through a typed operation. Operations return structured data; they do not print or contain CLI logic.
4. Map expected domain failures to stable `LocalhostError` values at the operation boundary. Return provider-compatible failures from public API routes.
5. Test both paths against the same resulting state when both exist.

Bind `defineOperation` once per plugin ID/state/config combination. Use Zod object inputs, JSON-compatible outputs, useful field descriptions, and ordinary camelCase operation keys. Do not optimize the domain model around generated CLI flags.

## Own state and lifecycle deliberately

- Initialize new durable state in `create`.
- Migrate older durable state in `update({ from, to })`; advance `stateVersion` only for a real storage contract change.
- Open process-owned resources and return instance state from `start`; release them idempotently in `stop`.
- Pair `seedSchema` with `lifecycle.seed`, or omit both. Treat seed as an explicit baseline, not startup logic.
- Use `onStarted` only to reconcile durable running work that may survive process interruption.
- Use `onTimeAdvanced` only for time-derived behavior. Make reconciliation idempotent by `advanceId` and persist effects before acknowledging completion.
- Use `ctx.clock.now()` for emulator time. Do not derive service behavior from ambient wall time.

Keep instance state out of module-level mutable variables. Importing the package and configuring its factory must not open files, start work, read ambient process state, or produce output.

## Track outbound work

Send plugin-owned outbound requests through `ctx.fetch`. Track asynchronous non-fetch work with `ctx.tasks.track`. Do not leave fire-and-forget promises outside the tracker.

Persist the logical event before scheduling delivery when interruption matters. Keep event identity and body stable across recovery, and put provider-specific retries in the plugin. Use `onStarted` or `onTimeAdvanced` only when the behavior genuinely needs those recovery points.

## Compose the public plugin

Return one side-effect-free factory from `definePlugin` with:

- a literal plugin `id` and positive integer `stateVersion`;
- Zod config and optional seed schemas;
- a plain Hono app typed with `PluginEnv`;
- bound operations;
- lifecycle hooks;
- instance-correct connection `values` and app-facing `env`.

Prefer a private dependency-injected factory for fault testing and one ordinary consumer-facing plugin factory export. Do not expose test-only operations or change the production operation inventory in fault variants.

## Prove the plugin

Use `@localhost2137/plugin-testkit` against the production factory when its fixture can describe the plugin honestly. A new state-version-1 plugin has no valid historical predecessor for the current fixture's ordered version contract; do not bump its version or invent one. Use focused public-surface, lifecycle, and persistence tests and disclose that testkit gap until a real prior schema exists.

Add plugin-specific tests for domain rules, persistence transactions and migrations, API/SDK compatibility, durable recovery, signatures, retries, and unsupported input behavior. The generic contract proves runtime integration; it does not prove provider fidelity.

Verify at least:

- import and configuration have no runtime side effects;
- two instances cannot share state;
- operation input and output validation is real;
- public routes receive only their instance's running context;
- reset, explicit seed, restart, upgrade, and future-version rejection behave correctly;
- outbound work is tracked and recovery produces no duplicate durable effect;
- connection URLs and exported environment values are instance-correct;
- package typecheck, build, tests, and public import surface pass.

## Review for simplicity

Before reporting completion, ask:

- Is this behavior owned by the plugin, and is its source of truth below every adapter?
- Does each new abstraction solve a present second use case?
- Can a file or wrapper be deleted without losing an invariant?
- Does failure, cancellation, restart, or double invocation leave durable state understandable?
- Does the compatibility claim describe only behavior that a test demonstrates?

Tell the human what supported behavior changed, how it was verified through the public surface, and which relevant compatibility limits remain. Avoid framework internals and promotional language unless they change how a plugin author must act.

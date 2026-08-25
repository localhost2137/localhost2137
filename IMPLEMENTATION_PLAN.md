# localhost2137 implementation plan

Status: implementation-ready proposal  
Prepared from: `concept.md` and `design/*`  
Date: 2026-08-25

## 1. Outcome and implementation strategy

localhost2137 should be built as a small local runtime kernel with multiple thin adapters around it, plus independently owned emulator plugins. The first releasable vertical slice should be the runtime, CLI, testing client, and a genuinely useful Slack plugin. Stripe should follow immediately as the second reference plugin because it validates that the clock and lifecycle abstractions are real rather than Slack-specific.

The architectural center is one operation executor:

```text
plugin operation definitions
            |
            v
     OperationExecutor
       /     |      \
      /      |       \
 TypeScript  CLI   control HTTP
   client          (agent/curl)
```

No adapter may contain emulator business logic. HTTP routes, CLI commands, TypeScript methods, generated help, and future MCP tools all describe or invoke the same registered operation.

The product should be delivered in two validation releases:

- **v0.1, Slack vertical slice:** plugin authoring API, runtime, instances, lifecycle, storage, public HTTP gateway, control API, CLI, connections/env, logging, task draining, testing API, Slack users/channels/messages/events, and one complete example bot.
- **v0.2, deterministic time vertical slice:** per-instance clock advancement, durable time-advance delivery, Stripe customers/prices/subscriptions/invoices/webhooks, and renewal tests.

Snapshots, forks, deterministic randomness, MCP, cloud execution, a web UI, compatibility certification, and broad service coverage are deliberately excluded until both reference plugins prove the kernel.

## 2. Decisions to lock before implementation

These decisions reconcile contradictions or unresolved points in the sketches. They should be recorded as short ADRs before public code is published.

| Area | Decision | Reason |
| --- | --- | --- |
| Runtime platform | ESM-only TypeScript targeting Node.js 24 LTS | Node 24 is the latest LTS line and has stable type stripping, while published code is still compiled to JavaScript. |
| Package manager | A pinned pnpm workspace, without Turborepo initially | Workspaces and ordinary scripts are enough at this repository size. |
| Service identity | The key in `services` is the route, CLI, storage, and programmatic identity | There is one source of truth and no `mount` override layer. |
| Public URL | Always `/{instance}/{service}/*`; CLI defaults the instance to `dev` | URL behavior remains explicit and test worlds never need extra ports. |
| Runtime API | Versioned under `/_/v1/*` | Agents and third-party tools will depend on it; versioning is cheap now and painful later. |
| Control endpoint shape | Instance is a path segment, for example `/_/v1/instances/dev/services/slack/operations/createUser` | Avoids mixing path-scoped public instances with query-scoped control instances. |
| Control security | Loopback-only in v0.x plus a per-runtime bearer token | The control plane is privileged and localhost endpoints are reachable from untrusted browser content. |
| Plugin HTTP API | Plain Hono app; runtime creates an instance-specific wrapper that injects `lh` | Preserves familiar Hono authoring without module-level mutable instance state. |
| Configuration | Ordinary `localhost.config.ts`, loaded with `tsx`'s programmatic import and validated once into an immutable resolved config | Supports normal TypeScript without depending on Node's intentionally limited type stripping rules. |
| Seed behavior | Fresh instances are empty. Seeding is explicit, may run once per reset, and runs plugin seeds before the scenario seed | Resolves the conflicting "fresh · seeded" and "never automatic" examples. |
| Service seed order | Sequential in configuration declaration order; top-level scenario last | Predictable, debuggable behavior is more important than insignificant seed parallelism. |
| Persistence version | Each plugin declares an integer `stateVersion`, not its npm package version | Storage compatibility is independent of package release version. |
| App callback URL | Each plugin owns one explicit callback URL setting such as `eventsUrl`; no top-level `app.baseUrl` in v0.1 | Removes ambiguous URL composition. A runtime routing abstraction can be added only when parallel inbound webhook routing is designed. |
| Connection API | Plugin returns `{ values, env }`; code reads `instance.slack.connection`, while merged env is `instance.env`; a configured service can set `exportEnv: false` | Removes naming inconsistencies and gives multi-mount users an explicit escape hatch for unavoidable env-name collisions. |
| IDs | Plugin-owned in v0.1; the Slack and Stripe databases use deterministic sequences | Avoids prematurely putting service-specific ID semantics into the kernel. Runtime randomness/ID capabilities remain a later ADR. |
| Clock | Per instance, durable, and either real-with-offset or pinned; explicit advance notifies plugins durably | Time is part of each isolated world, not process-global state. |
| Test execution | Canonical API is an explicit in-process `createTestRuntime()` followed by `runtime.createInstance()`; a client can also connect to a running daemon | Avoids hidden global servers and makes ownership/cleanup unambiguous. |
| Per-instance config overrides | Deferred; test runtimes receive an explicit complete config | A vaguely defined deep-merge contract would create type, persistence, and restart ambiguity. |
| Snapshots/forks | Not part of v0.1 or v0.2 public types, CLI help, or examples | Publishing placeholders would freeze an unproven storage-consistency contract. |
| Hot config reload | Deferred; config changes require a runtime restart | Dynamic plugin replacement and lifecycle rollback are not worth the initial complexity. |
| Plugin trust | Plugins are trusted local code, not sandboxed code | Storage helpers prevent accidental path mistakes but are not a security boundary. |

Before implementation, update the design sketches to match this table. In particular:

- remove the `mount` comment from `localhost.basic.config.ts`;
- change `localhost dev` output from "fresh · seeded" to "fresh · empty";
- remove statements that seed data is applied during materialization/reset unless `--seed` is supplied;
- change `localhost.billing` to `localhost.stripe` in the full config;
- use one connection name and shape in plugin/config/testing examples;
- move snapshot/fork examples to a clearly labeled future-design document;
- make the testing example use the explicit test-runtime owner and per-test instance cleanup.

## 3. Scope

### 3.1 v0.1 must include

- `defineConfig`, `definePlugin`, `defineOperation`, and `PluginEnv` public APIs;
- keyed service configuration with plugin config and optional declarative seed;
- TypeScript config discovery, loading, validation, and useful diagnostics;
- a single project runtime and Node HTTP server;
- persistent and ephemeral instances isolated by URL and storage path;
- plugin lifecycle: `create`, `update`, `start`, `stop`, `seed`;
- plain Hono public API mounting;
- one operation executor with input and output validation;
- JSON Schema introspection generated from Zod 4;
- versioned authenticated control HTTP API;
- generated CLI operation commands, JSON mode, stable exit codes, and help;
- runtime-owned connection metadata and generated `.localhost2137/.env` for `dev`;
- `localhost run -- <cmd>` with signal forwarding;
- per-instance clock reads and persisted clock state;
- bounded in-memory request, operation, and delivery logs;
- tracked outbound `ctx.fetch`, explicit task tracking, and `idle()`;
- an explicit test-runtime API and a remote client API;
- plugin contract test kit;
- first-party Slack plugin and end-to-end ping/pong example;
- Linux, macOS, and Windows CI, package validation, and release automation.

### 3.2 v0.2 must include

- explicit clock advancement;
- durable, resumable plugin time-advance notifications;
- Stripe reference plugin;
- subscription renewal, invoice, and webhook flows;
- clock and cross-plugin scenario tests.

### 3.3 Explicitly deferred

- snapshots, restore, forks, and copy-on-write storage;
- deterministic random number generation or runtime-owned IDs;
- automatic real-time schedulers;
- MCP generation;
- plugin marketplace, verification, and conformance infrastructure;
- hosted runtimes, shared state, CI service, and authentication beyond local control access;
- web dashboard;
- config hot reload and instance start/stop commands;
- arbitrary non-loopback binding;
- automatic app callback interception/rerouting;
- per-instance configuration overrides;
- custom CLI aliases, positional arguments, or a plugin CLI DSL.

## 4. Architecture

### 4.1 Dependency direction

```text
                        public plugin definitions
                                  |
                                  v
                         authoring contracts
                                  |
                                  v
filesystem/config ---> runtime kernel <--- clock/task/log ports
        |                    |
        |                    v
        |             operation executor
        |               /           \
        v              v             v
      CLI client   control HTTP   test/client SDK
                         |
                         v
                    Hono server
                         |
                         v
                plugin public Hono apps
```

Dependency rules:

1. Authoring contracts are pure definitions and types. They perform no filesystem, server, environment, or process work.
2. The kernel depends on interfaces for storage, clock persistence, logging, HTTP delivery, and process-independent configuration.
3. Node filesystem, Hono server, CLI, config loader, and child-process support are adapters that depend inward on the kernel.
4. Plugins depend only on the public authoring contract plus their chosen ecosystem libraries.
5. The Slack and Stripe plugins never import runtime internals.
6. CLI and control HTTP handlers never invoke plugin functions directly; they use the application service/client and operation executor.
7. Internal folders have no catch-all `utils.ts` or broad internal barrel exports. Shared code must have a specific domain name and a clear owner.

Use small data structures and functions by default. Classes are justified only for stateful resource owners such as `ProjectRuntime`, `InstanceManager`, `TaskTracker`, or `ControlClient`.

### 4.2 Repository layout

```text
/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── eslint.config.js
├── vitest.config.ts
├── docs/
│   ├── architecture/
│   │   ├── overview.md
│   │   └── adr/
│   ├── plugin-authoring.md
│   ├── testing.md
│   └── cli.md
├── packages/
│   ├── localhost2137/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── authoring/       # public descriptors and inferred types
│   │   │   ├── config/          # discovery, import, validation, normalization
│   │   │   ├── kernel/          # runtime orchestration and application services
│   │   │   ├── node/            # fs, locking, server, process adapters
│   │   │   ├── control/         # control API routes and client
│   │   │   ├── cli/             # command composition and renderers
│   │   │   ├── testing/         # explicit test-runtime facade
│   │   │   ├── index.ts         # public root exports only
│   │   │   └── bin.ts
│   │   └── test/
│   └── plugin-testkit/
│       ├── src/
│       └── test/
├── plugins/
│   ├── slack/
│   │   ├── src/
│   │   │   ├── domain/          # pure Slack behavior and response mapping
│   │   │   ├── persistence/     # schema, migrations, repositories
│   │   │   ├── api/             # public emulated Slack HTTP routes
│   │   │   ├── operations/      # control operations
│   │   │   ├── lifecycle.ts
│   │   │   └── index.ts
│   │   └── test/
│   └── stripe/                  # added in v0.2 with the same shape
├── examples/
│   ├── slack-ping-bot/
│   └── stripe-renewal/          # v0.2
└── tests/
    ├── integration/
    ├── e2e/
    └── package-smoke/
```

`localhost2137` remains one published package with explicit exports:

- `localhost2137` — config and plugin authoring;
- `localhost2137/client` — remote control client;
- `localhost2137/testing` — in-process test runtime and typed instance handle;
- `localhost2137/package.json` only if tooling requires it;
- binary `localhost`.

Do not split the kernel, CLI, and client into separate npm packages until an independent consumer or versioning need exists. Source modules provide boundaries without creating release coordination overhead.

`@localhost2137/plugin-testkit` is separate because plugin packages consume it only as a development dependency.

All published packages declare `engines.node >= 24`. Because the public authoring contract carries Hono apps and Zod schemas across package boundaries, supported Hono and Zod major ranges must be aligned deliberately across the host and plugins. Validate npm and pnpm packed-consumer layouts so duplicate dependency placement cannot break schema introspection or route dispatch. Official plugins peer-depend on a compatible `localhost2137` contract range and keep emulator-only libraries such as `better-sqlite3` as their own direct dependencies.

### 4.3 Composition roots

There should be exactly three places that assemble concrete dependencies:

- CLI `dev`: config loader + disk storage + lock + Hono Node server + real fetch;
- test runtime: supplied config + temporary storage + Hono Node server on port `0` + real or injected fetch;
- kernel tests: in-memory/fake ports where behavior is more important than filesystem/HTTP integration.

Environment variables, `process.cwd()`, signals, stdout/stderr, and the global `fetch` must be read only by these outer adapters. Kernel and plugin behavior receive explicit values and capabilities.

## 5. Public contracts

The following shapes describe responsibilities, not final syntax. Exact types should be settled with compile-time fixtures before publishing.

### 5.1 Operation

```ts
defineOperation({
  description: "Create a user in the workspace",
  input: z.object({
    name: z.string().meta({ description: "Display name" }),
    admin: z.boolean().default(false),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    admin: z.boolean(),
  }),
  async run(ctx, input) {
    return ctx.state.users.create(input);
  },
});
```

Rules:

- operation keys are camelCase JavaScript identifiers and become kebab-case CLI names;
- v0.x input schemas must be Zod objects;
- operation results must be JSON-compatible and must pass the output schema;
- operation code returns data and never writes to stdout/stderr;
- input and output parsing occurs in `OperationExecutor` for every adapter;
- validation returns structured field issues;
- unexpected exceptions are converted at the adapter boundary, logged with correlation ID, and never leak stack traces through the control API by default;
- an operation receives an `AbortSignal` and must pass it to cancellable work;
- nested/union inputs remain usable over TypeScript and HTTP but use CLI `--input-json` until a safe flag mapping exists.

Generate JSON Schema with Zod 4's supported `z.toJSONSchema()` API. Do not inspect undocumented Zod internals. The CLI compiler consumes a deliberately small JSON Schema subset:

- string, number, integer, boolean;
- enum;
- arrays of scalar values as repeated flags;
- optional/defaulted fields;
- field descriptions and examples.

Anything outside that subset gets `--input-json <json>` and clear generated help. This is simpler and more stable than pretending every Zod schema maps naturally to flags.

### 5.2 Plugin

```ts
const slack = definePlugin({
  id: "slack",
  stateVersion: 1,
  description: "Stateful Slack emulator",
  configSchema,
  seedSchema,
  api,
  operations,
  lifecycle: {
    create,
    update,
    start,
    stop,
    seed,
    onTimeAdvanced, // optional, used from v0.2
  },
  connection,
});
```

`definePlugin()` should return a typed factory. Calling that factory with `{ config, seed?, exportEnv? }` produces a side-effect-free configured service descriptor. `exportEnv` defaults to `true`; setting it to `false` keeps typed connection values but excludes that mount from the merged dotenv projection. Importing or configuring a plugin must not open a database, read environment variables, start a server, or write files.

Required invariants checked at config resolution:

- plugin ID, service key, operation keys, and state version are valid;
- `_` is reserved and names match `^[a-z][a-z0-9-]*$`;
- operation CLI names do not collide after kebab-case conversion;
- config and seed parse successfully;
- the plugin Hono app exists but has not started a server;
- exported connection environment names use `^[A-Z][A-Z0-9_]*$` and do not collide across services whose `exportEnv` is enabled;
- all schema-to-JSON-Schema conversions succeed for introspection.

### 5.3 Plugin context

The runtime supplies the minimum useful capability set:

```ts
interface RunningPluginContext<State, Config> {
  readonly instanceId: string;
  readonly serviceKey: string;
  readonly config: Readonly<Config>;
  readonly state: State;                 // available after start
  readonly storage: PluginStorage;
  readonly clock: PluginClock;
  readonly signal: AbortSignal;
  readonly log: PluginLogger;
  readonly tasks: TaskTracker;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
```

`ctx.fetch` is fetch-compatible, automatically logged, correlated, abortable, and tracked so `idle()` can observe outstanding delivery work. `ctx.tasks.track(label, promise)` exists for asynchronous plugin work that is not a fetch. Fire-and-forget promises outside the tracker are a plugin contract violation.

Lifecycle hook context types are phase-specific. `create` and `update` receive storage/config/clock/log capabilities but cannot access `state`; `start` returns `state`; and public routes, operations, `seed`, `stop`, and the future time hook receive a running context with `state`. Model this in TypeScript rather than documenting a property as conditionally available.

`PluginStorage.path(relative)`:

- rejects absolute paths, empty paths, `.`/`..` traversal, and NUL bytes;
- returns a path beneath that instance/service data directory;
- does not pretend to sandbox malicious plugin code;
- exposes no database or ORM abstraction.

### 5.4 Lifecycle

Use an explicit internal state machine:

```text
absent
  | create storage + manifest
  v
stopped -- start --> running -- stop --> stopped
   |                   |
   | update            | seed / operation / request
   v                   v
stopped              running

running -- reset --> stopping --> staged-old-state --> create --> running
running -- destroy -> stopping --> renamed-to-trash --> absent
```

Semantics:

- `create(ctx)` runs once for a newly materialized service directory;
- `update(ctx, { from, to })` runs while stopped whenever stored `stateVersion` is lower; version changes are recorded only after success;
- a stored version higher than the plugin supports is a hard error;
- `start(ctx)` opens process resources and returns the service state;
- `stop(ctx)` is called at most once for each successful start and must be idempotent;
- `seed(ctx, seed)` is explicit and runs while the instance is exclusively leased;
- `onTimeAdvanced` is absent from the v0.1 behavior but its final contract is validated with Stripe before v0.2;
- failures identify instance, service, hook, and correlation ID;
- no later hook for an instance starts after an earlier service hook fails;
- shutdown attempts all stops and reports aggregate failures.

Lifecycle mutation obtains an exclusive instance lease. Public API requests and operations obtain shared running leases. Reset, destroy, stop, seed, and time advancement wait for active leases and tracked tasks, subject to a bounded timeout and cancellation.

Seeding has a persisted `unseeded | seeding | seeded | seed_failed` status. A successful seed cannot be repeated until reset. A failure moves the instance to `seed_failed`, retains diagnostics, and requires reset because cross-plugin state cannot be rolled back transactionally. `instance create --seed` is atomic from the caller's perspective: on seed failure the new instance is stopped and removed. A top-level scenario seed receives an operation facade scoped to the already-held exclusive lease; it still uses `OperationExecutor` validation/logging but does not reacquire the lease and deadlock.

### 5.5 Connection metadata

```ts
connection({ instanceId, serviceKey, baseUrl, config }) {
  return {
    values: {
      apiUrl: `${baseUrl}/${instanceId}/${serviceKey}/api`,
      botToken: config.botToken,
      signingSecret: config.signingSecret,
    },
    env: {
      SLACK_API_URL: "...",
      SLACK_BOT_TOKEN: "...",
      SLACK_SIGNING_SECRET: "...",
    },
  };
}
```

Programmatic access is:

```ts
instance.slack.connection.apiUrl;
instance.env.SLACK_API_URL;
```

The runtime writes the merged `dev` environment atomically to `.localhost2137/.env`. It owns that file completely and places a generated-file header in it. It never appends to or edits the user's `.env`. `localhost env --instance <id> --format json|dotenv` renders other instances.

An env collision is a boot-time configuration error that names both owners and suggests setting `exportEnv: false` on one or both mounts. Disabling export does not remove typed `connection` values, public routes, or operations; the application wires those mounts explicitly.

### 5.6 Top-level scenario seed

`defineConfig` may include `async seed(instance)`. The `instance` parameter is fully inferred from the configured service keys and exposes only operations and connection values, not lifecycle/storage internals. The runtime invokes it after all declarative plugin seeds succeed. Calls pass through `OperationExecutor` inside the seed's existing exclusive execution scope, so validation, output checking, logging, and task tracking remain identical without reacquiring the instance lease.

## 6. Runtime internals

### 6.1 Resolved configuration

Config loading is a pipeline with one output type:

```text
discover file
  -> import TypeScript
  -> verify default export
  -> validate runtime fields
  -> validate every configured plugin envelope
  -> normalize absolute storage path and URLs
  -> detect identities/env collisions
  -> deep-freeze resolved config
  -> compute non-secret config fingerprint
```

Rules:

- discovery walks upward from the explicit `--cwd` or current working directory and stops at the filesystem root;
- `--config` bypasses discovery;
- paths resolve relative to the config file, not whatever process later uses them;
- config import errors remain distinguishable from schema validation errors;
- diagnostics include config path, service key, Zod path, expected value, and actionable correction;
- config is loaded once at boot;
- plugin configuration is available on every boot, but seed is never replayed automatically;
- secrets are not expected in local world config, but config values and Authorization headers are still redacted from logs by default.

Use `tsx`'s `tsImport()` rather than a process-wide loader hook. Keep loading contained and test ESM, CommonJS package boundaries, top-level await, config imports, syntax errors, and Windows paths.

### 6.2 Storage layout

```text
.localhost2137/
├── lock
├── runtime.json                 # active daemon descriptor; token stored separately
├── control-token               # mode 0600 where supported
├── .env                        # generated connection env for dev
├── instances/
│   └── dev/
│       ├── instance.json       # runtime schema, clock, seed and service metadata
│       └── services/
│           └── slack/
│               ├── service.json
│               └── data/       # only this path is given to the plugin
└── trash/                       # staged reset/destroy directories
```

Durability and safety rules:

- one daemon has the exclusive write lock for a storage root;
- manifests have their own schema version and are validated on read;
- manifest writes use a sibling temp file, file sync where practical, and atomic rename;
- instance and service IDs are validated before any path is formed;
- reset renames the old instance directory into `trash`, creates the replacement, and restores the old directory if replacement creation fails;
- destroy renames to trash before reporting success, then cleans the trash asynchronously;
- startup repairs or reports interrupted lifecycle transitions rather than silently guessing;
- orphaned storage from removed service keys is retained and surfaced by `localhost doctor`; it is never automatically deleted;
- changing the plugin ID behind an existing service key is a conflict requiring an explicit reset;
- ephemeral test instances are marked in their manifest and cleaned after a crashed test runtime on next startup;
- storage format and recovery cases have fixture-based compatibility tests.

### 6.3 Instance manager

`InstanceManager` owns instance records, not HTTP routes or CLI rendering. It provides:

- `create({ id, persistence, seed })`;
- `list()` and `get(id)`;
- `reset(id, { seed })`;
- `destroy(id)`;
- `seed(id)`;
- `startPersisted()` and `stopAll()`;
- shared operation/request leases and exclusive lifecycle leases.

Instance IDs use the same conservative lowercase pattern as service keys, with a short maximum length. Generated test IDs combine a readable prefix with a collision-resistant suffix and do not depend on Vitest-specific environment variables.

At `localhost dev` boot:

1. discover, load, and resolve config without mutating runtime state;
2. acquire the resolved storage root's lock;
3. create `dev` if absent, without seeding;
4. discover persistent instance manifests;
5. reconcile configured services (create new service storage, update old state versions, retain removed-service storage);
6. start services in config order;
7. bind the server;
8. write active runtime descriptor and token;
9. compute connections and atomically write `.localhost2137/.env`;
10. print ready output.

If any boot step fails, stop anything already started, close the server, remove the active descriptor, and release the lock. Persistent state remains available for diagnosis.

### 6.4 Public HTTP gateway

The outer Hono app has two route families:

```text
/_/v1/*                         runtime/control API
/:instance/:service/*           public emulated service APIs
```

The public gateway:

1. validates and resolves the instance and service;
2. obtains a shared running lease;
3. creates a request correlation record;
4. strips the `/{instance}/{service}` prefix while preserving method, query, body, and relevant headers;
5. invokes the instance-specific Hono wrapper;
6. releases the lease and records status/duration/size.

When a service starts, the runtime creates a wrapper Hono app whose middleware sets `c.set("lh", context)` before the plugin's plain Hono routes. A separate wrapper exists per instance/service while the plugin route definition itself can be shared. A mandatory two-instance contract test proves state does not leak through module closures.

Do not rebuild the outer route table when instances are added. Resolve the dynamic instance/service pair at request time.

### 6.5 Control API

Minimum endpoints:

```text
GET    /_/v1/health
GET    /_/v1/instances
POST   /_/v1/instances
GET    /_/v1/instances/:instance
DELETE /_/v1/instances/:instance
POST   /_/v1/instances/:instance/reset
POST   /_/v1/instances/:instance/seed
GET    /_/v1/instances/:instance/services
GET    /_/v1/instances/:instance/services/:service
POST   /_/v1/instances/:instance/services/:service/operations/:operation
GET    /_/v1/instances/:instance/logs
GET    /_/v1/instances/:instance/clock
POST   /_/v1/instances/:instance/clock/advance       # v0.2
POST   /_/v1/instances/:instance/idle
```

Requirements:

- every endpoint except health requires a bearer token;
- mutating requests require JSON content type;
- CORS is disabled by default and browser origins are rejected;
- request bodies have conservative size limits;
- errors use one versioned envelope: `{ error: { code, message, details?, correlationId } }`;
- success responses use `{ data: ... }` at HTTP level; CLI `--json` prints only the contained data;
- no control response includes stack traces, tokens, signing secrets, or full config;
- OpenAPI generation for this runtime-owned API is desirable after routes stabilize, not a prerequisite for the first vertical slice.

### 6.6 Operation executor

`OperationExecutor.execute({ instanceId, serviceKey, operationKey, rawInput, signal })` is the only operation path. It:

1. resolves the running instance and service;
2. resolves the operation descriptor;
3. parses input;
4. obtains a running lease;
5. creates a child context/correlation ID;
6. runs the operation;
7. parses and JSON-serializability-checks output;
8. records timing and outcome;
9. releases the lease;
10. returns typed data or a structured error.

Plugin-authored expected errors use a small `LocalhostError` type with stable code, message, optional details, HTTP status, and retryability. Unknown errors become `PLUGIN_EXECUTION_FAILED` with internal cause retained only in logs.

### 6.7 Clock

Clock state belongs to an instance manifest. `ctx.clock.now()` returns a fresh `Date` value; mutating that returned object cannot mutate runtime time. The persisted representation is epoch milliseconds.

Modes and advancement:

- **real:** `now = wall clock + persisted offset`;
- **pinned:** `now = persisted instant`;
- `advance(duration)` increases offset or pinned instant;
- durations use a small documented grammar (`ms`, `s`, `m`, `h`, `d`, `w`) with no calendar-month ambiguity;
- plugin code receives a fresh `Date` value and formats service-specific timestamps itself.

For v0.1, `ctx.clock.now()` is usable and deterministic in pinned tests. For v0.2, advancing time creates a durable `advanceId` with `{ from, to }`. The runtime records acknowledgements per service and invokes `onTimeAdvanced` in config order. On a crash, unacknowledged services resume. Hooks must be idempotent by `advanceId`; the Stripe plugin's test suite proves this. `idle()` includes tasks generated by these hooks.

Do not implement an automatic wall-clock scheduler in v0.2. Plugins reconcile due work on explicit advancement and may also reconcile at relevant API/operation boundaries.

### 6.8 Task draining and outbound delivery

`TaskTracker` is per instance and supports nested tasks:

- `track(label, promise)` increments before work begins and always decrements;
- errors are retained and surfaced by `idle()`;
- `idle()` waits until the tracker remains empty after a microtask turn, so tasks spawned by completing tasks are included;
- callers can supply timeout and abort signal;
- shutdown stops accepting tasks, aborts outstanding runtime fetches after a grace period, and reports unfinished labels;
- `ctx.fetch` records target, method, attempts, status, duration, and correlation while redacting sensitive headers/bodies.

Slack delivery retries should belong to the Slack plugin because retry rules emulate Slack, while transport tracking, cancellation, and logs belong to the runtime.

### 6.9 Observability

Always-on bounded ring buffers should record:

- public API requests;
- control operations;
- lifecycle events;
- outbound deliveries;
- plugin structured log events.

Every record includes wall-clock observation timestamp, virtual instance time when relevant, correlation ID, instance, service, kind, status, and duration where applicable. Set both entry-count and byte-size bounds to prevent a single large payload exhausting memory. Bodies are omitted by default; plugins can log safe structured summaries. Authorization, cookies, tokens, signing secrets, and configured redaction keys are scrubbed centrally.

`localhost logs [service] --instance dev --tail 50 --json` reads the ring through the control client. Live follow/SSE and disk persistence are deferred until demand exists.

## 7. CLI

Use Commander as an argument/help engine, but instantiate a new `Command` inside a factory for every invocation so CLI tests do not share global state. The CLI is a renderer and control client, never a runtime backdoor.

### 7.1 v0.1 commands

```text
localhost dev [--config path] [--host 127.0.0.1] [--port 2137]
localhost describe [service] [--instance dev] [--json]
localhost exec <service> [operation] [generated flags] [--input-json json] [--json]
localhost instance create <id> [--seed]
localhost instance list [--json]
localhost instance reset <id> [--seed]
localhost instance destroy <id>
localhost seed [--instance dev]
localhost env [--instance dev] [--format dotenv|json]
localhost run [--instance dev] -- <command...>
localhost logs [service] [--instance dev] [--tail n] [--json]
localhost clock status [--instance dev] [--json]
localhost doctor [--json]
```

`clock advance` is enabled in v0.2. Snapshot commands do not appear until their contract exists.

### 7.2 CLI behavior contract

- `stdout` contains requested data only; diagnostics and progress use `stderr`;
- `--json` is valid JSON with no colors, banners, spinners, or explanatory suffixes;
- all destructive commands name the exact target and are non-interactive only when the target is explicit;
- no required interactive prompt exists;
- unknown instance errors list existing instances and the create hint;
- CLI detects a missing/stale daemon descriptor and gives a single actionable `localhost dev` instruction;
- `exec <service> --help` is built from operation introspection;
- `exec <service> <operation> --help` includes input descriptions, types, defaults, enums, examples, and JSON fallback;
- kebab/camel conversion is tested for acronym and collision cases;
- `localhost run` passes through the child exit code and signals, injects only connection env, and is not a process supervisor.

Stable exit classes:

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | CLI usage or input validation |
| 3 | runtime unavailable/config boot failure |
| 4 | instance, service, or operation not found |
| 5 | lifecycle conflict or invalid state |
| 10 | plugin operation/lifecycle failure |
| 130 | interrupted |

## 8. Programmatic and testing APIs

### 8.1 Explicit test-runtime ownership

Canonical shape:

```ts
const runtime = await createTestRuntime({
  config,
  storage: "temporary",
  port: 0,
});

const instance = await runtime.createInstance({ seed: false });

try {
  const alice = await instance.slack.createUser({ name: "Alice" });
  await instance.slack.sendMessage({
    channel: "general",
    from: alice.id,
    text: "ping",
  });
  await instance.idle();
} finally {
  await instance.destroy();
  await runtime.close();
}
```

The test runtime binds one OS-assigned port and all its instances remain path-isolated on that server. It owns a temporary root and removes it after a successful close. Failed cleanup reports the retained path for diagnosis.

The typed instance handle is generated through mapped types from the supplied config. Each service exposes operation methods plus typed `connection`; runtime capabilities (`idle`, `seed`, `reset`, `destroy`, `clock`, `env`) live at the instance root.

### 8.2 Remote client

`connectRuntime({ url, token })` returns an untyped/introspection-driven control client suitable for scripts and framework adapters. When a typed imported config is available, a generic helper may supply operation types without changing runtime behavior.

Do not use JavaScript `Proxy` for internal runtime dispatch unless it materially improves inference and its error behavior is tested. A generated plain object per configured service is easier to inspect and debug.

### 8.3 Test framework integration

First ship framework-neutral APIs. Then provide documented recipes:

- Vitest global setup owns one test runtime; workers connect to it and create unique instances;
- per-file setup creates/destroys an instance;
- Playwright worker fixtures use one instance per worker;
- Jest global setup follows the same remote-client pattern.

A small official Vitest helper can be added after the recipe is proven in the example project. It should not be embedded in the kernel.

### 8.4 Plugin test kit

Every plugin must be able to run the same contract suite:

- importing and configuring has no side effects;
- invalid config and seed fail with paths;
- create/start/stop/update ordering;
- create and update failure recovery;
- two instances have no state leakage;
- public Hono routes receive the correct context;
- every operation validates input and output;
- introspection contains every operation;
- CLI names are unique and representable/fallback correctly;
- storage paths cannot escape accidentally;
- connection URLs and env values are instance-correct;
- env collisions are caught;
- tracked fetch and `idle()` work;
- reset returns to empty and `reset --seed` applies seed exactly once;
- state remains after runtime restart;
- future stored versions are rejected;
- plugin state-version fixture upgrades preserve data.

## 9. Slack reference plugin

Slack is not a toy sample; it is the v0.1 product proof. Implement a coherent supported subset and say exactly what is unsupported.

### 9.1 Data model

Use plugin-owned SQLite through `better-sqlite3`, raw parameterized SQL, explicit migrations, and repository modules. Avoid an ORM until the schema demonstrates enough repetition to justify one.

Initial tables:

- workspace metadata and deterministic counters;
- users and bot/user tokens;
- channels;
- channel memberships;
- messages, threads, timestamps, and deletion state;
- outbound event deliveries and attempts.

Use transactions for multi-row changes such as channel creation with memberships and message creation with event enqueueing. Enable foreign keys and WAL. Repositories return domain records, not raw database rows.

### 9.2 Public Slack-compatible API

Initial supported methods:

- `auth.test`;
- `users.list`;
- `conversations.list`;
- `conversations.members`;
- `conversations.history`;
- `chat.postMessage`.

Requirements:

- preserve Slack's `/api/METHOD_FAMILY.method` routes;
- support the request encodings actually used by common Slack SDKs for these methods, not JSON only;
- return Slack-shaped `{ ok: false, error }` failures rather than runtime control errors;
- authenticate bearer tokens according to the supported local model;
- implement stable pagination semantics if a supported method exposes pagination;
- maintain a compatibility fixture for each method with normalized real Slack examples where licensing/privacy permits;
- document deliberate differences such as HTTPS, rate limits, enterprise features, and unsupported scopes.

### 9.3 Slack control operations

- `createUser`;
- `createChannel`;
- `addUserToChannel`;
- `sendMessage` (simulates a user and emits Events API delivery);
- `listMessages`;
- optionally `setPresence` only if the demo consumes it.

The operation layer calls the same domain services/repositories used by public routes. It does not call the plugin's own HTTP endpoint and does not duplicate write rules.

### 9.4 Events delivery

- explicit nullable `eventsUrl` plugin config;
- Slack-shaped event envelope;
- request timestamp and HMAC signature headers using the local signing secret;
- one bounded, tracked delivery attempt in v0.1, with non-2xx/timeout failure visible in delivery logs;
- all transport through tracked `ctx.fetch`;
- `instance.idle()` waits for delivery work currently in flight;
- stable event IDs so applications can test deduplication;
- test cases for success, non-2xx, timeout, event identity, and signature verification.

Slack-compatible retry scheduling and retry headers move to v0.2, when durable virtual-time advancement exists. Until then, the support matrix must explicitly say that automatic Events API retries are not emulated.

Do not emulate every Slack API. Publish a support matrix and add methods only when a real integration/example needs them.

## 10. Stripe reference plugin and time validation

Start only after the Slack vertical slice and kernel API review. Its purpose is to pressure-test state evolution and time.

Initial public API subset:

- customers create/retrieve/list;
- products/prices retrieve/list as needed by the example;
- subscriptions create/retrieve/cancel;
- invoices retrieve/list;
- webhook signature and delivery.

Control operations:

- create customer/product/price;
- create subscription;
- list invoices/events;
- force a payment outcome for deterministic retry scenarios.

Clock scenarios:

- create monthly subscription at a pinned instant;
- advance 30 days;
- generate exactly one renewal invoice and event;
- replay an unacknowledged `advanceId` after simulated crash without a duplicate invoice;
- branch-like scenario coverage is done by creating two seeded instances, not snapshots;
- real-with-offset and pinned mode agree on due-date calculations for the same instants.

Use the Stripe plugin to decide whether `onTimeAdvanced` belongs in the lifecycle contract as proposed. Do not publish that hook from `localhost2137` before this spike passes.

## 11. Code-quality rules

These are repository policy, not style suggestions.

### 11.1 Module design

- one module has one reason to change and a name tied to its domain;
- no generic `helpers`, `common`, `misc`, `manager`, or `utils` dumping grounds;
- no runtime god object: lifecycle, operations, task tracking, clock, logs, config, and HTTP dispatch have separate owners;
- adapter handlers should mostly parse, call one application method, and render;
- plugin API routes and operations call domain services, never each other;
- persistence rows, domain models, API payloads, and control DTOs are separate types where their semantics differ;
- dependencies are constructor/factory parameters; no ambient mutable singletons;
- no module-level mutable plugin state;
- no untracked promise and no ignored rejected promise;
- resource owners expose idempotent `close`/`stop` methods and have failure-path tests;
- comments explain invariants and decisions, not syntax;
- public exports are intentional and reviewed; internal barrel exports are avoided.

### 11.2 TypeScript policy

Enable at least:

```text
strict
noUncheckedIndexedAccess
exactOptionalPropertyTypes
useUnknownInCatchVariables
noImplicitOverride
noFallthroughCasesInSwitch
verbatimModuleSyntax
isolatedDeclarations
```

- no `any` in authored source except a documented compatibility boundary;
- parse external data at its boundary and keep it typed thereafter;
- use discriminated unions for lifecycle/error states;
- represent IDs with semantic aliases where it prevents mixups, without introducing runtime wrapper classes;
- use exhaustive `never` checks for state machines;
- keep public generics inferable from normal calls; a public API that needs manual generic arguments in common usage fails ergonomic review.

### 11.3 Tooling gates

Use:

- Biome for formatting and baseline linting;
- ESLint only for rules Biome cannot cover, especially restricted architectural imports;
- TypeScript project references and `tsc -b` for build/type checking;
- Vitest for unit/integration/e2e tests;
- a dependency-boundary check for forbidden inward/outward imports;
- Knip for unused files/exports/dependencies;
- API report/type fixtures for public surface changes;
- `publint`, Are the Types Wrong, and packed-tarball smoke tests before publish;
- Changesets for versioning and changelogs.

Pin the package manager and commit the lockfile. Use exact versions for repository tooling and normal compatible ranges for public runtime dependencies only after upgrade policy is documented.

### 11.4 Review checklist

Every implementation PR answers:

1. Which layer owns this behavior?
2. Is it reachable through more than one adapter, and if so is the logic shared below them?
3. What invariant prevents cross-instance or cross-service leakage?
4. What happens on cancellation, partial failure, restart, and double invocation?
5. Is externally supplied data parsed exactly once at a boundary?
6. Is a new abstraction solving a current second use case, or merely predicting one?
7. Does the public contract need to be public now?
8. Is there a contract/integration test rather than only a mocked unit test?

## 12. Test strategy

### 12.1 Test layers

| Layer | Purpose | Examples |
| --- | --- | --- |
| Pure unit | Transformations and state rules | name conversion, duration parsing, manifest transitions, Slack response mapping |
| Kernel component | Orchestration through fake ports | lifecycle failures, leases, seed ordering, time acknowledgement |
| Adapter integration | Real boundaries | temp filesystem, config import, Hono request dispatch, child process signals |
| Plugin contract | Shared guarantees | two-instance isolation, output validation, storage, connection env |
| End-to-end | User-observable flow | start daemon, CLI create world, app calls Slack, event returns, inspect state |
| Package smoke | Published artifact behavior | install packed tarballs in an empty fixture and run JS/TS examples |

Prefer real temporary directories and `app.request()`/real loopback HTTP over deep mocks. Use fake clocks and fetch implementations only at explicit ports.

### 12.2 Critical failure cases

- invalid or throwing config import;
- duplicate services/operations/env variables;
- server port already in use;
- stale lock/runtime descriptor;
- crash during create/update/reset/destroy;
- public request racing reset;
- Ctrl-C during operation and during child process run;
- plugin start succeeds but later service start fails;
- plugin stop throws;
- output schema mismatch;
- invalid JSON and oversized body;
- unauthenticated/cross-origin control requests;
- instance/service path traversal attempts and encoded separators;
- two instances handling concurrent requests through the same plugin Hono app;
- tracked task spawning another task during `idle()`;
- daemon restart with persistent state;
- state version downgrade;
- partial time-advance acknowledgement and restart;
- Windows path, process, and signal differences.

### 12.3 CI matrix

Required checks on every PR:

- format and lint;
- dependency boundaries;
- typecheck and public type fixtures;
- unit/component tests with coverage;
- integration/e2e tests on Linux;
- package build, export validation, and tarball smoke test.

Required before release:

- full suite on current Node 24 LTS across Ubuntu, macOS, and Windows;
- Slack SDK/example compatibility test;
- fresh install using npm and pnpm consumers;
- upgrade fixture from the previously released state manifest/database;
- documentation command snippets executed where practical;
- dependency/security/license review;
- npm provenance and changelog verification.

Use coverage as a missing-test signal, not a target to game. The kernel, lifecycle recovery, control authorization, and path handling should have branch coverage expectations higher than display formatting.

## 13. Delivery phases and exit criteria

Each phase ends with executable behavior and documentation. Do not merge large scaffolding phases with no vertical proof.

### Phase 0 — contract freeze and repository foundation

Work:

- turn the decisions in section 2 into ADRs;
- update design sketches to remove contradictions;
- create pnpm workspace, Node 24 policy, TypeScript configs, lint/format/test/build scripts;
- create package skeletons and enforce dependency boundaries;
- establish Changesets and CI;
- add public type inference fixtures for the proposed config/plugin/operation shape.

Exit criteria:

- clean install/build/test on all three OS families;
- no package has a circular dependency;
- sample config type-checks with no manual generic arguments;
- importing a sample plugin has a test proving no side effects.

### Phase 1 — authoring contract and config pipeline

Work:

- implement `defineOperation`, `definePlugin`, `defineConfig`, configured service descriptors, and inferred operation types;
- implement Zod 4 introspection and constrained CLI-schema representation;
- implement config discovery and `tsImport()` loading;
- implement full resolution/normalization/collision diagnostics;
- define structured errors and redaction primitives.

Exit criteria:

- basic/full config fixtures load or fail with precise snapshots;
- config is immutable after resolution;
- operation metadata round-trips to machine-readable JSON;
- unsupported CLI schemas receive a tested JSON fallback;
- no config import triggers plugin runtime work.

### Phase 2 — storage, lifecycle, and instance kernel

Work:

- implement validated storage layout, manifests, atomic writes, and lock;
- implement instance/service state machines and shared/exclusive leases;
- implement create/update/start/stop/reset/destroy/seed orchestration;
- implement persisted per-instance clock reads;
- implement task tracker and structured ring logs;
- add crash/interruption fixture recovery.

Exit criteria:

- two instances persist independent plugin state across kernel restart;
- lifecycle hook ordering and every failure path are tested;
- reset rollback preserves old state when replacement creation fails;
- destroy never computes a path from unvalidated input;
- seeding is explicit and exactly-once-per-reset at runtime level.

### Phase 3 — operation executor and HTTP runtime

Work:

- implement operation executor and structured error mapping;
- implement per-instance Hono wrappers and dynamic public gateway;
- implement versioned control API and control authentication;
- implement tracked/redacted fetch and idle endpoint;
- implement Node server startup and graceful shutdown.

Exit criteria:

- one operation gives identical validated data through direct executor and control HTTP;
- two-instance Hono isolation test passes under concurrent load;
- unauthorized and browser-origin control mutations fail;
- server shutdown drains requests/tasks or reports the bounded timeout;
- public plugin responses are not wrapped in control envelopes.

### Phase 4 — control client, CLI, connections, and process integration

Work:

- implement runtime descriptor discovery and authenticated control client;
- implement all v0.1 commands and stable exit mapping;
- implement dynamic operation help/flags and `--input-json`;
- implement connection metadata, env rendering, and atomic dev env file;
- implement `localhost run --` signal and exit-code behavior;
- implement `doctor` checks for stale runtime/orphaned storage/version issues.

Exit criteria:

- the complete non-Slack CLI transcript works against a minimal fixture plugin;
- stdout JSON parses for every `--json` command;
- CLI has black-box tests for errors and signals;
- env collisions stop boot with precise owners;
- a packed `localhost2137` tarball exposes the binary and all declared subpaths.

### Phase 5 — testing API and plugin test kit

Work:

- implement explicit `createTestRuntime`, typed `createInstance`, cleanup, and remote connect;
- implement generated typed service operation objects;
- implement plugin contract suite;
- write Vitest/Playwright/Jest integration recipes;
- port the design testing sketch to the supported API.

Exit criteria:

- parallel worker example uses one runtime and separate path-scoped instances;
- a thrown assertion still destroys its instance and final runtime close removes temporary storage;
- state never crosses two simultaneous instances;
- the fixture plugin passes the entire published contract suite.

### Phase 6 — Slack vertical slice

Work:

- implement Slack database schema, migrations, repositories, and domain services;
- implement supported public API and control operations;
- implement signed single-attempt Events API delivery, delivery logs, and idle behavior;
- build the ping/pong bot example with a mainstream Slack SDK;
- publish a compatibility/support matrix and plugin authoring walkthrough;
- run an agent from empty app code through the full discover/build/test loop and record friction.

Exit criteria:

- the example bot is built and tested without real Slack credentials/workspace;
- daemon, CLI, control HTTP, and TypeScript APIs manipulate the same Slack state;
- Slack state survives restart and updates from a version-0 fixture;
- event signature, event identity, timeout, non-2xx, and inspection cases pass;
- an external coding agent can discover operations using only CLI/control introspection;
- no kernel change is needed to express Slack-specific business logic.

### Phase 7 — clock advancement and Stripe validation

Work:

- spike and finalize durable `onTimeAdvanced` semantics;
- implement clock-advance control/client/CLI behavior and recovery;
- extend Slack delivery with its documented retry schedule and retry headers, driven by durable time reconciliation;
- implement the minimal Stripe state model, API, operations, and webhooks;
- build renewal example and idempotent crash-recovery tests;
- review the plugin contract using both Slack and Stripe; remove accidental service-specific assumptions.

Exit criteria:

- advancing a pinned instance produces exactly one due invoice/event;
- retrying an interrupted advance produces no duplicate durable effects;
- advancing through Slack retry deadlines produces the expected bounded attempts without duplicate event IDs;
- Slack needs no special-case runtime logic and remains green;
- the time hook is published only after both first-party plugin suites approve it.

### Phase 8 — alpha hardening and release

Work:

- performance and leak tests for many instances, routes, operations, logs, and deliveries;
- threat review for control API, paths, config execution, and sensitive logs;
- complete CLI/reference/plugin/testing docs;
- tarball/install/upgrade matrices;
- semver/support policy, issue templates, security policy, and release automation;
- publish alpha packages and collect real-project feedback.

Exit criteria:

- documented alpha limitations are honest and specific;
- cold boot, operation latency, instance count, and memory baselines are recorded with regression thresholds;
- every public example is executed in CI;
- prior persisted alpha fixture upgrades successfully;
- rollback instructions exist for a failed package release;
- release artifacts include provenance and correct exports/types/binary.

## 14. Post-alpha roadmap

Build later capabilities in this order. Each stage needs evidence from real projects; none should force cloud or marketplace concerns into the local kernel.

### 14.1 Stabilize third-party plugin authoring

- recruit at least one external plugin author;
- build a small third reference plugin outside the monorepo from published packages only;
- add a plugin scaffolder only after repeated boilerplate is measured;
- publish contract compatibility ranges and a deprecation policy;
- add a plugin manifest containing identity, runtime contract range, capabilities, and documentation links without inventing a new distribution format;
- keep npm as installation and version resolution.

Exit signal: an external author can publish and maintain a useful plugin without importing internals or asking for repository-specific setup.

### 14.2 Snapshots and forks

Snapshots must operate on arbitrary plugin-owned files, so design them around quiescence rather than databases:

1. obtain an exclusive instance lease;
2. drain tracked work;
3. stop all plugins so files are consistent;
4. snapshot instance manifest plus service directories with checksums;
5. restart the source instance;
6. restore into a new/stopped target, validate plugin IDs/state versions, then start;
7. implement forks first as full copies with a pluggable copy strategy;
8. add reflink/copy-on-write optimizations only where the filesystem supports them and always retain the portable copy path.

Do not promise snapshots across incompatible plugin state versions until an explicit migration-on-restore policy exists. Add corruption, insufficient-space, interruption, and concurrent-request tests before exposing CLI commands.

### 14.3 Reproduction and deterministic capabilities

- add a persisted runtime seed and deterministic random capability only after Slack/Stripe reveal the required primitives;
- make plugins opt into runtime IDs/randomness rather than mandate service-inappropriate formats;
- define a reproduction bundle containing config fingerprint, plugin versions/state versions, instance clock, runtime seed, and optional snapshot reference;
- ensure sensitive config values are redacted or explicitly opted in.

Exit signal: a failed CI/agent run can be recreated locally from a compact report without relying on accidental wall time or random values.

### 14.4 Generated MCP adapter

- generate MCP tools from the same operation metadata and executor;
- keep HTTP, CLI, and TypeScript as primary interfaces;
- map structured operation errors without agent-specific business logic;
- compare discoverability and token cost against `describe --json` before committing to richer metadata.

MCP remains an adapter package/process, not a dependency of the kernel or plugin contract.

### 14.5 Compatibility and verification

- create a separate conformance toolkit that can send an approved request corpus to a real API and an emulator;
- normalize volatile fields, timestamps, IDs, headers, and unordered collections explicitly;
- store scrubbed fixtures with provenance and terms-of-use review;
- report compatibility by supported endpoint/behavior rather than a single misleading percentage;
- run drift checks on schedules appropriate to each vendor;
- introduce Community/Verified/Official labels only with published, auditable criteria.

Conformance code depends on public plugin/runtime interfaces. The kernel never imports vendor credentials or real-API clients.

### 14.6 Hosted and team capabilities

Hosted instances, shared snapshots, PR environments, and enterprise controls should be a separate control/service layer speaking the versioned runtime protocol. Keep local execution usable without an account, network connection, telemetry, or cloud SDK. Introduce remote storage/snapshot implementations through proven ports rather than conditionals scattered through the local filesystem adapter.

### 14.7 Stable v1 bar

Do not declare v1 until:

- Slack and Stripe support real production-code integration tests;
- at least one useful third-party plugin exists;
- public authoring, control, and persistence contracts have survived multiple compatible releases;
- upgrade fixtures cover every released storage schema;
- Linux/macOS/Windows installation and operation are routine;
- the security model and plugin trust boundary are documented and reviewed;
- telemetry remains opt-in and local use remains account-free;
- snapshot/fork APIs are either production-ready or clearly excluded from v1 rather than partially exposed.

## 15. Recommended pull-request slicing

Keep PRs reviewable and independently green. A practical sequence is:

1. workspace/tooling/boundary rules;
2. authoring types plus compile-only fixtures;
3. operation metadata and JSON Schema conversion;
4. config loader/resolver diagnostics;
5. storage paths/manifests/lock;
6. lifecycle and instance leases;
7. operation executor;
8. Hono public dispatcher;
9. authenticated control API/client;
10. CLI static commands;
11. generated operation CLI;
12. connections/env/run command;
13. task tracking/logs/idle;
14. test runtime and plugin test kit;
15. Slack persistence/domain;
16. Slack public API;
17. Slack operations/events;
18. complete example, docs, and alpha hardening;
19. clock-advance spike;
20. Stripe vertical slice.

A PR should not mix a public API change, storage migration, and unrelated CLI presentation work. Public type changes include type fixtures and an API report diff. Storage changes include old/new manifest or plugin database fixtures.

## 16. Risk register

| Risk | Early signal | Mitigation |
| --- | --- | --- |
| Runtime becomes a framework that duplicates plugin concerns | kernel adds DB, ORM, service payload, or retry abstractions | enforce ownership table and require two-plugin justification for new capabilities |
| `ProjectRuntime` becomes a god object | unrelated tests instantiate the whole runtime; frequent merge conflicts | split lifecycle, operation, clock, task, log, config, and gateway owners behind narrow methods |
| Plain shared Hono app leaks instance state | two-instance test sees cross-world data | instance-specific wrapper/context; testkit forbids closure-based state by behavior |
| CLI generation depends on unstable Zod internals | Zod update breaks help | generate supported JSON Schema and compile only a documented subset |
| Programmatic tests hide server/process globals | leaked ports and order-dependent tests | explicit test-runtime owner and mandatory cleanup |
| Reset/destroy corrupt state on failure | half-created directories | stop, rename to trash, create replacement, restore on failure, recovery fixtures |
| Plugin upgrade corrupts storage | npm patch unexpectedly triggers migration | explicit integer state version, durable version fixtures, reject downgrade |
| Local control API is abused from browser content | unexpected instance mutations | loopback bind, bearer token, JSON-only mutation, origin rejection, no CORS |
| Virtual time duplicates effects after crash | duplicate invoices/events | durable advance ID, per-service acknowledgement, idempotence contract |
| Slack scope expands indefinitely | many endpoints with shallow fidelity | support matrix tied to real examples and explicit non-goals |
| Native SQLite install hurts adoption | missing binary on a supported platform | release CI/install smoke on OS/arch policy; reassess adapter before stable release |
| Type inference becomes clever and fragile | slow TS or unreadable errors | compile-time budgets, ordinary mapped types, ergonomic fixtures, fewer public generics |
| Logs leak credentials or grow unbounded | tokens/bodies in diagnostics, memory growth | central redaction, no bodies by default, entry and byte caps |
| Future features freeze premature contracts | snapshot methods exist but do nothing robustly | exclude all deferred features from public types/help/examples |

## 17. Product-level acceptance test

The v0.1 alpha is ready only when this can run from a clean checkout and packed packages:

1. install `localhost2137` and `@localhost2137/slack`;
2. write the minimal TypeScript config;
3. start `localhost dev` and observe an empty `dev` world;
4. discover Slack operations from `localhost exec slack --help` and JSON introspection;
5. start an example bot with `localhost run -- ...`;
6. create a user/channel and send `ping` through control operations;
7. receive a correctly signed Slack event in the app;
8. let the app call the emulated `chat.postMessage` endpoint;
9. call `idle()` and inspect `pong` through CLI, control HTTP, and typed client;
10. restart the daemon and observe preserved state;
11. reset the instance and observe an empty world;
12. reset with seed and observe the declared baseline exactly once;
13. run the same scenario in parallel test instances without shared state or extra per-instance ports;
14. diagnose request, operation, and webhook history without exposing tokens.

This single test demonstrates the actual thesis: an agent can create, manipulate, inspect, reset, and test an external-service world without credentials or manual external setup.

## 18. Definition of done for any feature

A feature is done when:

- ownership and public/private status are explicit;
- implementation follows the dependency direction;
- input, output, error, cancellation, and cleanup behavior are defined;
- happy path, boundary, concurrency where relevant, and failure recovery are tested;
- machine-readable CLI/control behavior is stable;
- docs and examples use only supported contracts;
- no deferred placeholder is exposed;
- package/type/export checks pass;
- relevant old persisted fixtures still load or fail with a documented migration path;
- observability can explain the feature's failure without enabling debug builds.

## 19. Technical references used for this plan

- [Node.js release status](https://nodejs.org/en/about/previous-releases) — Node 24 is the latest LTS baseline as of this plan.
- [Node.js TypeScript execution](https://nodejs.org/api/typescript.html) — built-in stripping is intentionally limited and ignores `tsconfig` features.
- [tsx programmatic `tsImport`](https://tsx.is/dev-api/ts-import) — contained runtime import of TypeScript config files.
- [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs) and [Hono routing/grouping](https://hono.dev/docs/api/routing) — Node adapter, route composition, and ordering behavior.
- [Zod JSON Schema](https://zod.dev/json-schema) — supported `z.toJSONSchema()` conversion and metadata.
- [Commander documentation](https://github.com/tj/commander.js/blob/master/Readme.md) — strict options, nested commands, generated help, and async actions.
- [Vitest parallelism](https://vitest.dev/guide/parallelism) — worker/process behavior that the testing recipe must accommodate.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — supported Node policy and platform prebuild approach for the reference plugins.
- [Slack Web API](https://docs.slack.dev/apis/web-api/) and [Slack Events API](https://docs.slack.dev/apis/events-api/) — public method shape, request encodings, authentication, delivery, and retry behavior.

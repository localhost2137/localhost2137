# Public plugin contract

Confirm exact declarations in the installed `localhost2137` package. Use only exports from its public root.

## Authoring shape

```ts
import { Hono } from "hono";
import {
  defineOperation,
  definePlugin,
  type PluginEnv,
} from "localhost2137";
import { z } from "zod";

const configSchema = z.object({ endpoint: z.url() });
type Config = z.output<typeof configSchema>;
type State = Readonly<{ service: DomainService }>;

const operation = defineOperation<"example", State, Config>();
const inspectState = operation({
  description: "Inspect the local example service",
  input: z.object({}),
  output: z.object({ count: z.int() }),
  run: (context) => ({ count: context.state.service.count() }),
});

const api = new Hono<PluginEnv<State, Config>>();
api.get("/state", (context) => {
  const runtime = context.get("lh");
  return context.json({ count: runtime.state.service.count() });
});

export const example = definePlugin({
  api,
  configSchema,
  connection: ({ baseUrl, instanceId, serviceKey }) => {
    const apiUrl = `${baseUrl}/${instanceId}/${serviceKey}`;
    return { env: { EXAMPLE_API_URL: apiUrl }, values: { apiUrl } };
  },
  description: "Local example service emulator",
  id: "example",
  lifecycle: {
    create(context) {
      return initializeStore(context.storage.path("state.db"));
    },
    start(context): State {
      return { service: openDomainService(context.storage.path("state.db")) };
    },
    stop(context) {
      return context.state.service.close();
    },
  },
  operations: { inspectState },
  stateVersion: 1,
});
```

The names in this structural example are illustrative, not promised plugin behavior. Keep the real plugin's configuration, connection fields, routes, and operations specific to the service it emulates.

## Context capabilities

`create`, `update`, and `start` receive `BasePluginContext<Config>`:

- readonly `config`, `instanceId`, and `serviceKey`;
- `storage.path(relativePath)` for the service's isolated data directory;
- `clock.now()`, `signal`, and structured `log`.

Routes, operations, `seed`, `onStarted`, `onTimeAdvanced`, and `stop` receive `RunningPluginContext<State, Config>`, which adds:

- the state returned by `start`;
- tracked `fetch`;
- `tasks.track(label, promise)`.

Do not make `create` or `start` depend on running-state capabilities they do not receive.

## Lifecycle meanings

| Hook | Use |
| --- | --- |
| `create` | Initialize absent durable state. It may run again after an interrupted attempt, so repeating it must be safe. |
| `update` | Migrate stopped durable state from the recorded version to the declared version. |
| `start` | Open process resources on each start and return instance-local state. |
| `onStarted` | Reconcile persisted running work after all services start and before readiness. |
| `seed` | Apply explicitly requested, schema-validated baseline data. |
| `onTimeAdvanced` | Idempotently reconcile one committed `{ advanceId, from, to }` window. |
| `stop` | Close resources after a successful start; tolerate repeated cleanup paths. |

Only `create` and `start` are required. Declaring `seedSchema` requires `seed`; omitting the schema forbids it.

## Operations and errors

- Bind operations once with `defineOperation<"plugin-id", State, Config>()` and pass only descriptors from that binder to the plugin.
- Use a Zod object input. Runtime adapters validate both input and output.
- Return JSON-compatible data. Keep output schemas aligned with what `run` actually returns.
- Pass `context.signal` to cancellable work.
- Throw `LocalhostError` for expected control-operation failures, using a stable upper-snake-case code, a safe message, an HTTP status from 400 through 599, and only safe JSON details.
- Keep provider-compatible HTTP errors in public route response shapes rather than runtime control envelopes.

## Hono and instance isolation

The Hono app is a route table shared across instances. Read instance state only from `context.get("lh")`; never close over mutable state opened by lifecycle hooks. The runtime mounts the app below `/{instance}/{service}` and injects a separate running context for each instance.

## Persistence and compatibility

The runtime gives the plugin a safe relative path, not a database abstraction. Keep database selection, transactions, migrations, and durable event records inside the plugin. Reject accidental path escape through normal `storage.path` use; do not hardcode global storage paths.

`stateVersion` describes the plugin's durable storage format, not its package release. Keep real old-schema fixtures. A newer stored version must fail rather than downgrade silently.

## Tracked and durable work

`context.fetch` is fetch-compatible and already participates in runtime task tracking. Use `context.tasks.track` for additional asynchronous work, including processing a response body after a tracked fetch when that completion matters to `idle()`.

For recoverable delivery, persist the event and its delivery state transactionally with the domain effect. Schedule delivery afterward. Reconcile pending records from `onStarted` when they must survive process interruption. If due work depends on explicit virtual time, reconcile it idempotently from `onTimeAdvanced` using the supplied advance ID and time window.

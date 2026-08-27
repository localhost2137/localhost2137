# Public plugin contract

Confirm exact declarations in the installed `localhost2137` package. Use only exports from its
public root.

## Checked authoring shape

This complete version-1 service is the repository's executable first-plugin example:

```ts title="src/status-plugin.ts"
import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

const statusSchema = z.object({
	message: z.string().nullable(),
	state: z.enum(["operational", "degraded", "outage"]),
});
const setStatusInput = z.object({
	message: z.string().optional(),
	state: statusSchema.shape.state,
});

type Config = Readonly<Record<string, never>>;
type State = Readonly<{ statusPath: string }>;
type Status = z.output<typeof statusSchema>;

const initialStatus: Status = { message: null, state: "operational" };
const operation = defineOperation<"status", State, Config>();

const readStatus = operation({
	description: "Read the current status",
	input: z.object({}),
	output: statusSchema,
	run: (context) => loadStatus(context.state.statusPath),
});

const setStatus = operation({
	description: "Set the status exposed to the application",
	input: setStatusInput,
	output: statusSchema,
	run: async (context, input) => {
		const status: Status = {
			message: input.message ?? null,
			state: input.state,
		};
		await saveStatus(context.state.statusPath, status);
		return status;
	},
});

const api = new Hono<PluginEnv<State, Config>>();
api.get("/v1/status", async (context) => {
	const { state } = context.get("lh");
	return context.json(await loadStatus(state.statusPath));
});

export const statusPlugin = definePlugin({
	api,
	configSchema: z.object({}),
	connection: ({ baseUrl, instanceId, serviceKey }) => {
		const apiUrl = `${baseUrl}/${instanceId}/${serviceKey}`;
		return {
			env: { STATUS_API_URL: apiUrl },
			values: { apiUrl },
		};
	},
	description: "Local status service",
	id: "status",
	lifecycle: {
		create: (context) => saveStatus(context.storage.path("status.json"), initialStatus),
		start: (context): State => ({
			statusPath: context.storage.path("status.json"),
		}),
	},
	operations: { readStatus, setStatus },
	stateVersion: 1,
});

async function loadStatus(path: string): Promise<Status> {
	return statusSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function saveStatus(path: string, status: Status): Promise<void> {
	await writeFile(path, `${JSON.stringify(status)}\n`, "utf8");
}
```

Keep real configuration, connection fields, routes, operations, and error shapes specific to the
service being emulated. Do not rename this teaching service into a compatibility claim.

## Context capabilities

`create`, `update`, and `start` receive `BasePluginContext<Config>`:

- readonly `config`, `instanceId`, and `serviceKey`;
- `storage.path(relativePath)` for the service's isolated data directory;
- `clock.now()`, `signal`, and structured `log`.

Routes, operations, `seed`, `onStarted`, `onTimeAdvanced`, and `stop` receive
`RunningPluginContext<State, Config>`, which adds:

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

Only `create` and `start` are required. Declaring `seedSchema` requires `seed`; omitting the schema
forbids it.

## Operations and errors

- Bind operations once with `defineOperation<"plugin-id", State, Config>()` and pass only
  descriptors from that binder to the plugin.
- Use a Zod object input. Runtime adapters validate both input and output.
- Return JSON-compatible data. Keep output schemas aligned with what `run` actually returns.
- Pass `context.signal` to cancellable work.
- Throw `LocalhostError` for expected control-operation failures, using a stable upper-snake-case
  code, a safe message, an HTTP status from 400 through 599, and only safe JSON details.
- Keep provider-compatible HTTP errors in public route response shapes rather than runtime control
  envelopes.

## Hono and instance isolation

The Hono app is a route table shared across instances. Read instance state only from
`context.get("lh")`; never close over mutable state opened by lifecycle hooks. The runtime mounts the
app below `/{instance}/{service}` and injects a separate running context for each instance.

## Persistence and compatibility

The runtime gives the plugin a safe relative path, not a database abstraction. Keep database
selection, transactions, migrations, and durable event records inside the plugin. Use
`storage.path()` rather than hard-coded global storage paths.

`stateVersion` describes the plugin's durable storage format, not its package release. Keep real
old-schema fixtures. A newer stored version must fail rather than downgrade silently.

## Tracked and durable work

`context.fetch` is fetch-compatible and already participates in runtime task tracking. Use
`context.tasks.track` for additional asynchronous work, including processing a response body after a
tracked fetch when that completion matters to `idle()`.

For recoverable delivery, persist the event and its delivery state transactionally with the domain
effect. Schedule delivery afterward. Reconcile pending records from `onStarted` when they must
survive process interruption. If due work depends on explicit virtual time, reconcile it
idempotently from `onTimeAdvanced` using the supplied advance ID and time window.

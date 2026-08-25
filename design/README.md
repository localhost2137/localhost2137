# Design sketches: configuration & integration

These files are **design artifacts**, not implementation. They exist so we can
argue about the shape of localhost2137 before building it. The drafts in
`example/../localhost.config.ts` and `example/../lib/slack.ts` were the starting
point; everything here is a fuller proposal.

## Files

| File | Shows |
| --- | --- |
| `localhost.basic.config.ts` | Smallest useful config |
| `localhost.full.config.ts` | Every config knob we think v1 needs, annotated |
| `slack.plugin.ts` | Proposed plugin-authoring contract (resolves open TODOs in `lib/slack.ts`) |
| `testing.example.test.ts` | Programmatic API: explicit test runtime and ephemeral instances |
| `future.snapshots-and-forks.md` | Deferred interaction ideas, not a public contract |
| `cli.session.sh` | The whole interaction story as a terminal transcript |

## The interaction loop these examples encode

```
localhost dev                     1. boot an empty world from localhost.config.ts
        │
        ├── writes .localhost2137/.env
        │
app under test loads that .env    2. app talks to emulated APIs (HTTP)
        │                            emulator delivers webhooks back to the agent
agent / human / test              3. manipulates the world via control plane
        │                          (CLI · TS API · plain HTTP — same operations)
        └── inspect logs and queries → edit code → repeat
```

## URL scheme

One server, everything path-addressed (decided):

```
http://127.0.0.1:2137/{instance}/{service}/…     services, e.g. /dev/slack/api/chat.postMessage
http://127.0.0.1:2137/_/v1/{endpoint}/…          versioned runtime API
```

- Default instance is `dev` — `/dev/slack` when unspecified.
- `_` is reserved: no instance or plugin may ever be named `_`.
- Instances are isolated by path, not by port. Parallel test instances are just
  more ids (`t-w1`, `t-w2`, …) on the same runtime — no port juggling.
- The server process is disposable; instance storage persists. `localhost dev`
  remounts every existing instance on boot and auto-creates `dev` if missing.

## Decisions embedded in these sketches

Each of these is debatable — see chat discussion.

1. **Plugins are factory functions in a keyed `services` map.**
   `services: { slack: slack({ config: {...} }) }`. The key is THE identity
   (route, CLI selector, storage namespace, `localhost.slack`) — no override
   layer: if you want `/stripe`, name the key `stripe`. Envelope separates
   `config` / `seed`.
2. **Credentials are world-data, not secrets.** Hardcoding
   `"xoxb-local-acme"` is correct and intentional. The config defines the
   simulated world; nothing needs vault-grade handling.
3. **Connection metadata closes the loop to the app — as sugar, not authority.** Each
   plugin declares env vars an app needs (`SLACK_BASE_URL`, …). The runtime
   merges them into `.localhost2137/.env` and `localhost env --json`. Manual
   wiring stays first-class: config values are ordinary constants you can put
   in your own .env however you like (multi-bot setups do exactly this).
4. **Config is a world template, not an instance list.** One config describes
   one world. Instances are materializations of it (persistent `dev`,
   ephemeral ones in tests). Per-instance config lives in code via
   `createInstance({ overrides })`, later.
5. **Two-layer world-building, explicitly triggered.** `localhost seed` runs
   plugins' declarative seed interpreters first (baseline world), then the
   config's top-level `seed(localhost)` for cross-service scenarios via
   operations. Seeding is NEVER automatic — fresh instances start empty;
   predictability beats convenience.
6. **Plugin `api` is a plain module-level `new Hono()`.** Familiarity wins:
   no runtime dialect to learn, agents pattern-match known libraries. The
   app is a route table, not a server; the runtime mounts the same table
   under every instance and injects per-instance context via Hono variables
   (`c.get("lh")`; `PluginEnv<S, C>` exists purely as a typing helper).
   Lifecycle: `create → update? → start → seed? → stop`, where `create` runs
   once on empty storage, `update({ from, to })` fires when the plugin's
   integer state version changed on an existing instance, and `seed` only runs
   when asked.
   No migrate hook — storage internals are plugin business; the runtime
   only says WHEN.
7. **Control plane is also plain HTTP** under the reserved, versioned `/_/v1/*`
   namespace. Instance identity is a path segment, for example
   `/_/v1/instances/dev/services/slack/operations/createUser`. It is generated
   from the same operations and protected by a per-runtime bearer token.
   Services live under `/{instance}/{service}/*`.
8. **Observability is always on** (ring buffers), not a config option:
   `localhost logs slack`, `localhost logs webhooks`.
9. **Instances are managed, not configured.** Noun-first CLI:
   `localhost instance create|list|reset|destroy`, targeted elsewhere via
   `--instance` (default `dev`) or `LOCALHOST_INSTANCE`. Create = live —
   no docker-style start/stop split for v1. Unknown instance errors list
   what exists plus the create hint.

## Adopted from a second proposal (GPT review round)

- Flat Hono api + variable injection (replaces our factory-callback sketch);
  kept plain `new Hono()` per later decision.
- `connection()` returning `{ values, env }`: typed programmatic metadata and
  an env-var projection as separate concerns.
- Keyed `services:` map — identity comes from the object key
  (`services.slack` ⇒ `/slack`, CLI selector, storage namespace,
  `localhost.slack`), eliminating the redundant `name:` field.
- `await localhost.idle()` — drain in-flight webhook/event deliveries before
  asserting in tests.
- `localhost run -- <cmd>` — inject connection env into any command and
  forward signals, without becoming a process manager.

## Reserved runtime capability: ctx.fetch

Plugins make outbound requests (webhooks, token lookups) through `ctx.fetch`
instead of global fetch. Today it just performs the request. Later it becomes
the interception point: reroute deliveries aimed at your app's hostname so
parallel test worlds can share one port for inbound webhooks. Not v1-critical;
the contract reserves the seam now.

## Deliberately deferred

- Named instances declared in config (v1: one template + programmatic instances)
- `instance stop/start` — hooks exist; no use case before "downstream outage"
  style testing demands it (and that's better as a plugin operation anyway)
- `instance fork` / copy-on-write clones — waits for snapshots
- `env()` helpers — config is ordinary TS; `process.env` works already
- `extends`, config composition — TS spread is enough
- MCP server — falls out of operations later
- Per-plugin default seeds

## Callback URL decision

In v0.1 each plugin owns one explicit callback URL setting such as Slack's
`eventsUrl`. There is no top-level `app.baseUrl`. Runtime callback interception
and per-instance rerouting remain deferred until their parallel-test semantics
are designed.

## Decided in review round 2 (GPT comparison)

- Keyed `services:` map — identity from the object key; factories keep the
  nice call-style.
- Explicit envelope `{ config, seed? }`:
  - `config` — plugin-defined, validated, read every boot.
  - `seed` — plugin-declared schema. Kept OUT of `config` because the
    semantics differ (config = durable behavior, seed = initial world) and
    runtime features need to locate it uniformly.
- Two-layer world-building via explicit `localhost seed` (revised in round 3):
  plugin declarative seeds first, then the top-level scenario seed(localhost).
  Fresh instances start empty by design; reset = wipe → create → start.

## Decided in review round 3

- Plain `new Hono()` for plugin api — familiarity over dialects; `PluginEnv`
  exists only as a typing helper for the injected `lh` variable.
- Lifecycle: `create` (once, empty storage), `update({ from, to })` (integer
  state version changed on existing instances), `seed` (manual only),
  `start`/`stop`.
  No migrate hook — how a plugin manages its storage is its own business;
  the runtime only says WHEN.
- No `mount` namespace: the service key is the URL. If you want `/stripe`,
  name the key `stripe`. Double-mount env collisions are an error; wire
  those manually.
- `ctx.fetch` reserved on the plugin context as the future interception seam
  for outbound requests (see "Reserved runtime capability").

## Reconciled before implementation

- State compatibility uses a plugin-declared integer `stateVersion`, not its
  package version. `update` receives `{ from, to }`.
- IDs remain plugin-owned in v0.1; first-party plugins use deterministic
  database sequences.
- Programmatic connections consistently use
  `instance.<service>.connection`; merged environment variables use
  `instance.env`.
- Tests explicitly own a `createTestRuntime()` and its instances.
- Snapshot and fork sketches moved to `future.snapshots-and-forks.md`; they are
  not part of v0.1 or v0.2 types or examples.
- A plugin binds its literal ID and operation context once with
  `defineOperation<"slack", State, Config>()`; the resulting helper produces
  standalone operation descriptors and `definePlugin` rejects descriptors
  bound to a different plugin ID or state/config pair.
- `seedSchema` and `lifecycle.seed` are an inseparable pair. Omitting the
  schema forbids both the hook and `seed` in configured service envelopes.
- Top-level scenario seed receives only service operations and connection
  values. Instance lifecycle methods belong to external instance handles and
  cannot re-enter the seed's exclusive lease.
- `connection` is reserved as an operation key. `_`, `clock`, `destroy`, `env`,
  `idle`, `reset`, and `seed` are reserved as service keys. Phase 1 validates
  the same sets at runtime as the authoring types.
- The v0.1 external instance clock is read-only:
  `await instance.clock.status()` returns `{ mode, now }`; scenario seeds have
  no clock capability and `advance` remains absent until v0.2.

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
| `testing.example.test.ts` | Programmatic API: ephemeral instances, clock, snapshots, forks |
| `cli.session.sh` | The whole interaction story as a terminal transcript |

## The interaction loop these examples encode

```
localhost dev                     1. boot the world from localhost.config.ts (+ seed)
        │
        ├── writes .localhost2137/.env
        │
app under test loads that .env    2. app talks to emulated APIs (HTTP)
        │                            emulator delivers webhooks back to the agent
agent / human / test              3. manipulates the world via control plane
        │                          (CLI · TS API · plain HTTP — same operations)
        └── inspect: logs, queries, snapshots → edit code → repeat
```

## URL scheme

One server, everything path-addressed (decided):

```
http://127.0.0.1:2137/{instance}/{service}/…     services, e.g. /dev/slack/api/chat.postMessage
http://127.0.0.1:2137/_/{endpoint}/…             runtime's own API, e.g. /_/control/plugins
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
3. **`connect` maps close the loop to the app — as sugar, not authority.** Each
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
   Lifecycle: `create → (update) → seed? → start/stop`, where `create` runs
   once on empty storage, `update(fromVersion)` fires when the plugin's
   version changed on an existing instance, and `seed` only runs when asked.
   No migrate hook — storage internals are plugin business; the runtime
   only says WHEN.
7. **Control plane is also plain HTTP** under the reserved `/_/*` namespace
   (`/_/control/plugins`, `/_/control/slack/ops/createUser`), generated from
   the same operations. Services live under `/{instance}/{service}/*`. Free
   adapter, huge for curl/Playwright/agents, feeds MCP generation later.
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

## Open questions

- Who owns webhook path knowledge: runtime `app.baseUrl` composition vs
  explicit per-plugin `eventsUrl` (sketches show both).

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
- Lifecycle: `create` (once, empty storage), `update(fromVersion)` (plugin
  version changed on existing instance), `seed` (manual only), `start`/`stop`.
  No migrate hook — how a plugin manages its storage is its own business;
  the runtime only says WHEN.
- No `mount` namespace: the service key is the URL. If you want `/stripe`,
  name the key `stripe`. Double-mount env collisions are an error; wire
  those manually.
- `ctx.fetch` reserved on the plugin context as the future interception seam
  for outbound requests (see "Reserved runtime capability").

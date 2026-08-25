# ADR 0004: Plugin configuration and connections

- Status: Accepted
- Date: 2026-08-25

## Context

Plugins need familiar authoring tools and strong type inference without import
side effects. Earlier sketches disagreed about seed timing, application callback
URL composition, and connection property names.

## Decision

- Plugins expose a plain Hono route table. The runtime later creates an
  instance-specific wrapper that injects the running `lh` context.
- Each plugin binds one operation-definition helper with its literal ID and
  context: `defineOperation<"slack", State, Config>()`. It produces standalone
  operation values; `definePlugin` rejects operations bound to a different ID
  or state/config context. This explicit once-per-plugin binding avoids
  repeated generics without introducing a plugin builder DSL.
- `definePlugin()` returns a typed, side-effect-free factory. A keyed service
  entry is an envelope containing `config`, optional `seed`, and optional
  `exportEnv` (default `true`).
- `localhost.config.ts` is ordinary TypeScript. A later config adapter will
  import it with `tsx`'s programmatic `tsImport()`, validate it once, normalize
  paths relative to the config file, and freeze the resolved value.
- Fresh instances are empty. Seeding is explicit and may succeed only once per
  reset. Plugin seeds run sequentially in configuration order, then the
  top-level scenario seed runs.
- `seedSchema` and `lifecycle.seed` either both exist or are both absent. An
  unseeded plugin's configured-service envelope cannot contain `seed`.
- Each plugin owns an explicit callback setting such as `eventsUrl`. There is
  no top-level `app.baseUrl` in v0.1.
- A plugin connection returns `{ values, env }`. A service handle exposes typed
  values as `instance.slack.connection`; merged variables are in
  `instance.env`. `exportEnv: false` suppresses only the merged projection.
- `connection` is reserved as an operation key. `_`, `clock`, `destroy`, `env`,
  `idle`, `reset`, and `seed` are reserved as service keys so generated facade
  members cannot collide. Authoring types reject these names; Phase 1 config
  resolution and operation registration must enforce the identical sets at
  runtime.
- Environment-variable collisions between exported services are configuration
  errors.
- Top-level seed receives a narrow `ScenarioFacade`: service operations and
  connection values only. External `InstanceHandle` lifecycle/env methods are
  excluded because scenario execution already owns the exclusive seed lease.

## Consequences

Configuration remains inspectable TypeScript while imports do no work. Seed
behavior is predictable, multi-mount connection conflicts are explicit, and
parallel callback routing is not implied before it has a real design.

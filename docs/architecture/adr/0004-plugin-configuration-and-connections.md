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
- `definePlugin()` returns a typed, side-effect-free factory. A keyed service
  entry is an envelope containing `config`, optional `seed`, and optional
  `exportEnv` (default `true`).
- `localhost.config.ts` is ordinary TypeScript. A later config adapter will
  import it with `tsx`'s programmatic `tsImport()`, validate it once, normalize
  paths relative to the config file, and freeze the resolved value.
- Fresh instances are empty. Seeding is explicit and may succeed only once per
  reset. Plugin seeds run sequentially in configuration order, then the
  top-level scenario seed runs.
- Each plugin owns an explicit callback setting such as `eventsUrl`. There is
  no top-level `app.baseUrl` in v0.1.
- A plugin connection returns `{ values, env }`. A service handle exposes typed
  values as `instance.slack.connection`; merged variables are in
  `instance.env`. `exportEnv: false` suppresses only the merged projection.
- Environment-variable collisions between exported services are configuration
  errors.

## Consequences

Configuration remains inspectable TypeScript while imports do no work. Seed
behavior is predictable, multi-mount connection conflicts are explicit, and
parallel callback routing is not implied before it has a real design.

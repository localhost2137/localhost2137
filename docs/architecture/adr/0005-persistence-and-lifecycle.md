# ADR 0005: Persistence and lifecycle

- Status: Accepted
- Date: 2026-08-25

## Context

The runtime must manage arbitrary plugin-owned files without becoming a
database framework. Npm package versions are not a reliable storage format
version, and dynamic config replacement greatly complicates failure recovery.

## Decision

- Plugins own databases, schemas, migrations, files, and persistence logic.
  The runtime supplies only a validated, isolated data path and lifecycle
  timing.
- Every plugin declares a positive integer `stateVersion` independent of its
  package version.
- Lifecycle is `create`, optional `update`, `start`, `stop`, and optional
  explicit `seed`. `update` receives `{ from, to }` while stopped. Storage from
  a newer state version is rejected.
- When seeding is requested, services complete `create`/`update`, then `start`,
  before plugin seed hooks run in configuration order. The top-level scenario
  runs only after every plugin seed succeeds.
- `create`/`update` contexts cannot access running state; `start` returns it;
  public routes, operations, `seed`, and `stop` receive phase-appropriate
  running contexts.
- Reset and destroy use staged, recoverable filesystem transitions. Removed
  service storage is retained for diagnosis rather than deleted implicitly.
- Plugins are trusted local code. Path helpers prevent accidental traversal but
  are not a malicious-code sandbox.
- Hot config reload and instance start/stop commands are deferred; changing the
  config requires a runtime restart.

## Consequences

Plugin authors retain normal ecosystem choices. Runtime code owns when state
can be touched, not how it is encoded. Integer versions make compatibility
fixtures and downgrade rejection precise.

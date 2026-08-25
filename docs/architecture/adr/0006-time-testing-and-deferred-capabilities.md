# ADR 0006: Time, testing, and deferred capabilities

- Status: Accepted
- Date: 2026-08-25

## Context

Deterministic worlds require explicit ownership of time and test resources.
Publishing attractive but unproven snapshot, fork, override, or identifier APIs
would freeze contracts before two real plugins validate them.

## Decision

- Clock state belongs to each instance and is durable. It is either real with a
  persisted offset or pinned to a persisted instant.
- v0.1 exposes plugin clock reads and asynchronous client
  `instance.clock.status()` returning `{ mode, now }`, where `now` is RFC 3339.
  The scenario facade has no clock capability. Clock advancement and durable
  plugin notifications are finalized only with the Stripe v0.2 vertical slice.
- IDs remain plugin-owned in v0.1; first-party plugins use deterministic
  sequences. Runtime randomness and identifier capabilities need a later ADR.
- Canonical tests explicitly create and close a `createTestRuntime()`, then
  create and destroy instances owned by it. A separate client may connect to a
  running daemon.
- Test runtimes receive a complete explicit config. Per-instance deep-merge
  overrides are deferred.
- Snapshots, restore, forks, deterministic RNG, MCP, hot reload, callback
  interception, automatic schedulers, custom CLI DSLs, a web UI, cloud
  execution, and broad non-loopback hosting are absent from initial public
  types, help, and examples.

## Consequences

Resource ownership and cleanup are visible in every test. The first two plugins
can shape clock advancement without compatibility baggage. Deferred designs may
be documented as future work but cannot appear as callable placeholders.

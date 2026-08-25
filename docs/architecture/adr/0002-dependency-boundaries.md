# ADR 0002: Dependency boundaries

- Status: Accepted
- Date: 2026-08-25

## Context

The main maintainability risk is a runtime that absorbs plugin business logic,
or adapters that bypass shared application behavior. Package count alone does
not prevent either failure.

## Decision

- Public authoring contracts are side-effect-free definitions and types. They
  do not read the filesystem, environment, process state, or start resources.
- The kernel depends on narrow ports for storage, clock persistence, logs,
  delivery, and resolved configuration.
- Node filesystem/server/process code, config loading, control HTTP, and the
  CLI are outer adapters that depend inward.
- Plugins depend only on public authoring contracts and their own libraries.
- CLI and control handlers will invoke the same application services and
  operation executor; neither calls plugin implementation functions directly.
- Broad internal barrel exports and generic `utils`, `helpers`, `common`, or
  `misc` modules are prohibited.
- A repository boundary check supplements TypeScript project references and
  lint rules.

## Consequences

Business rules have one owner and remain reusable through every adapter.
Composition roots are limited to the daemon CLI, explicit test runtime, and
kernel tests. New shared abstractions require a current second use case rather
than a predicted one.

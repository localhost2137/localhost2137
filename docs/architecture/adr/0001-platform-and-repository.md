# ADR 0001: Platform and repository baseline

- Status: Accepted
- Date: 2026-08-25

## Context

The runtime, its adapters, test kit, and first-party plugins need one coherent
development environment. Adding a task orchestrator or independently versioned
kernel packages now would create release and dependency overhead before there
are consumers that need those boundaries.

## Decision

- Source is ESM-only TypeScript and published packages contain compiled
  JavaScript plus declarations.
- Node.js 24 LTS is the minimum supported runtime.
- The repository is a pnpm workspace with a pinned package-manager version.
- Ordinary recursive pnpm scripts and TypeScript project references are used;
  Turborepo is not introduced.
- `localhost2137` remains one published runtime package with explicit root,
  `client`, and `testing` exports when those entry points are implemented.
- `@localhost2137/plugin-testkit` is separate because plugin packages consume
  it only during development.
- Repository tooling uses exact versions. Published runtime dependency ranges
  will be chosen only when a compatibility policy exists.
- TypeScript incremental metadata is stored outside publishable `dist`
  directories. Source and declaration maps are omitted until packages also
  ship the sources needed to make those maps useful.
- Changesets uses public access for the intended unscoped runtime and scoped
  public plugin packages once their temporary Phase 0 `private` flags are
  deliberately removed.

## Consequences

The monorepo is easy to inspect and release, while source directories provide
internal boundaries. Creating another package requires an independent consumer
or versioning reason. All published package smoke tests must run against packed
artifacts, not workspace-only resolution.

# ADR 0003: Identities, routing, and control security

- Status: Accepted
- Date: 2026-08-25

## Context

Instances and services must be independently addressable without allocating a
port per test. Earlier sketches used an unversioned control namespace and a
query parameter for control-plane instance selection. Browser-accessible
localhost endpoints also require protection despite binding to loopback.

## Decision

- A configured service's key is its route, CLI, storage, and programmatic
  identity. There is no mount-name override.
- Public emulator routes are always `/{instance}/{service}/*`; CLI operations
  default to the `dev` instance.
- The reserved `_` namespace is never a valid instance or service identifier.
- Runtime and control endpoints are versioned under `/_/v1/*`.
- Control endpoints put the instance in the path, for example
  `/_/v1/instances/dev/services/slack/operations/createUser`.
- During v0.x the server binds only to loopback and all control endpoints except
  health require a per-runtime bearer token. Mutation requires JSON, browser
  origins are rejected, and CORS is disabled.

## Consequences

All worlds share one server while remaining explicit in URLs. Changing a
service key is an identity and storage change, not a presentation override.
The versioned, authenticated control protocol can support non-CLI clients
without exposing privileged mutation to arbitrary browser content.

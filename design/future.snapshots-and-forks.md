# Future design sketch: snapshots and forks

This document preserves the interaction idea without placing snapshots or forks
in the v0.1/v0.2 public contract. Their consistency and migration semantics must
be designed after Slack and Stripe validate the storage lifecycle.

Possible future usage:

```ts
const clean = await instance.snapshot();
await instance.clock.advance("30d");

const other = await clean.fork();
await other.clock.advance("90d");
```

Possible future CLI:

```sh
localhost snapshot save clean-seed
localhost snapshot restore clean-seed
```

A real proposal must define quiescence, plugin stop/restart behavior, arbitrary
file consistency, checksums, interruption recovery, state-version compatibility,
and portable copying before either shape becomes callable.

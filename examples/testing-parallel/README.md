# Parallel Vitest ownership example

This executable example starts exactly one temporary localhost2137 runtime in Vitest global setup.
Vitest serializes only its loopback URL and private control token to four worker processes. Each test
file creates and destroys its own ephemeral, path-isolated instance through `localhost2137/client`.
After mutation, workers rendezvous through a test-harness-owned filesystem barrier and then re-read
their unique values. Global teardown closes the sole runtime and removes both temporary roots.

Run it from the repository root:

```sh
pnpm --filter @localhost2137/example-testing-parallel test
```

The token is a test-run secret: never log it, expose it to browser code, store it in snapshots, or
write it to build artifacts. The owner passes it only through Vitest's in-memory serializable
provided context, and the runtime listens only on an OS-assigned loopback port.

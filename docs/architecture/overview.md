# Architecture overview

localhost2137 is a local runtime for executable, stateful emulators of external
developer services. Its kernel owns service lifecycle, instance isolation,
operation execution, time, and runtime-facing adapters. A plugin owns its HTTP
behavior, state representation, persistence implementation, and service rules.

The dependency direction is deliberately one-way:

```text
plugin definitions -> public authoring contracts -> runtime kernel
                                                   ^
                                                   |
                      config / filesystem / HTTP / CLI adapters
```

The package layout enforces that direction without splitting the runtime into
several independently versioned packages. `localhost2137` contains public
authoring contracts and, in later phases, private kernel and adapter modules.
Plugins import only the package's public contract. The separately published
`@localhost2137/plugin-testkit` will exercise plugins solely through that
contract.

One operation executor will eventually sit below the TypeScript, CLI, and
control HTTP adapters. Adapters may validate transport details and render
results, but must not contain emulator behavior.

Phase 0 freezes these boundaries and proves the intended public type shapes.
It does not implement runtime behavior. The accepted decisions are indexed in
[`adr/README.md`](adr/README.md).

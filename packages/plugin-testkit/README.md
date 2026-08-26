# `@localhost2137/plugin-testkit`

Framework-neutral contract cases for localhost2137 plugins. Register the returned cases with any
test runner, or execute the full suite with `runPluginContract`.

The fixture is trusted executable test code. The testkit owns runtime orchestration, cleanup,
generic invariants, and assertions, but it cannot infer plugin-specific business semantics. Every
factory and probe must exercise the selected configured service and return observed facts; returning
a synthetic `{ actual, expected }` match proves nothing about the plugin.

Keep the fixture beside the plugin, include every published operation in `world.operations`, and run
the suite in CI. The selected service key narrows operation keys at compile time, while runtime
introspection verifies that the inventory is complete.

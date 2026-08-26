# Plugin contract testing

Use `@localhost2137/plugin-testkit` as the shared runtime-integration proof. Inspect its installed README and exported `PluginContractFixture` type while building the fixture; the type is the source of truth.

## Register the cases

```ts
import { createPluginContractCases } from "@localhost2137/plugin-testkit";
import { describe, it } from "vitest";
import { pluginContractFixture } from "./plugin-contract-fixture.js";

describe("plugin contract", () => {
  for (const contractCase of createPluginContractCases(pluginContractFixture)) {
    it(contractCase.name, () => contractCase.run());
  }
});
```

Use `runPluginContract(fixture)` only when serial execution without test-runner registration is more appropriate.

## Build the selected-plugin harness honestly

Keep one development-only harness beside the plugin. Every base, fault, and version variant must:

- call the same production plugin factory;
- retain the same plugin ID, selected service key, and public operation inventory;
- vary only injected dependencies or lifecycle version/failure configuration;
- use the testkit-provided delivery URL only as ordinary plugin configuration;
- avoid test-only operations, routes, or response fields.

The testkit checks the successfully started variant's public identity and operation inventory. Review still has to confirm that the harness really uses production construction.

## Describe behavior declaratively

The fixture declares:

- an authoring module and named config export for side-effect probing;
- connection value and environment names;
- every public operation's valid input, expected output, and CLI representation class;
- invalid config and seed issue paths;
- two-instance Hono arrangement and observations;
- isolation, reset, seed, tracked-fetch, and injected fault scenarios;
- durable arrange/read/write observations and old/current/future versions;
- optional startup-recovery and time-advance durability scenarios.

Use production operations for arrangement and observation. Do not inspect the database or call repository methods from the fixture.

## Provide process fixtures

The authoring module must import and export a base config without starting a runtime, changing its working directory or environment, writing files, keeping resources open, or printing output.

Durability uses a CLI config module in a real daemon process. Build the same plugin-family variant from these testkit-owned environment variables:

- `LOCALHOST2137_CONTRACT_STORAGE`
- `LOCALHOST2137_CONTRACT_EVENTS`
- `LOCALHOST2137_CONTRACT_DELIVERY_URL`
- `LOCALHOST2137_CONTRACT_VERSION`
- `LOCALHOST2137_CONTRACT_FAIL_UPDATE`

When the optional time-advance fault is used, also consume the protocol exported by the testkit rather than inventing a parallel environment contract.

Keep old-version storage realistic. Arrange it through the declared old plugin variant or a maintained historical fixture, then prove upgrade and restart behavior through public operations.

## Add optional durability only when real

Use `startupRecovery` when a committed domain effect can leave pending delivery or other durable running work. Its arrangement must begin held remote delivery, interrupt the daemon, restart it, and observe recovery without duplicate durable effects.

Use `timeAdvance` when the plugin implements time-derived state through `onTimeAdvanced`. Declare a positive canonical duration and observations that remain identical after the committed advance and restart.

Do not add empty durability theater. If the plugin has no startup or time-derived work, omit the optional fixture section.

## Add semantic tests outside the contract

The contract fixture proves import behavior, lifecycle integration, isolation, validation, connection metadata, task tracking, reset/seed, persistence, and version handling. Add focused plugin tests for:

- domain invariants and transactions;
- real request encodings and provider-compatible responses;
- SDK behavior where the supported surface targets an SDK;
- signatures, event identity, retry schedules, cancellation, and recovery;
- every supported endpoint and each meaningful unsupported boundary;
- concrete schema migrations using historical files.

Prefer real temporary storage and loopback HTTP at adapter boundaries. Use injected failures at narrow public/plugin-owned seams, not runtime internals.

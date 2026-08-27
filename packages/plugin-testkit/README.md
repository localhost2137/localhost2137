# `@localhost2137/plugin-testkit`

Register the contract cases with the project's test runner. This is the complete checked
registration used by the Slack plugin:

```ts title="test/slack-contract.test.ts"
import { describe, it } from "vitest";
import { createPluginContractCases } from "@localhost2137/plugin-testkit";
import { slackContractFixture } from "./contract/slack-contract-harness.js";

describe("Slack plugin contract", () => {
	for (const contractCase of createPluginContractCases(slackContractFixture)) {
		it(contractCase.name, contractCase.run, 30_000);
	}
});
```

`createPluginContractCases(fixture)` returns 18 core cases. It appends one case when the fixture
declares time-advance recovery and one when it declares startup recovery. Use
`runPluginContract(fixture)` only when serial execution without named test-runner cases is more
appropriate.

## What the fixture proves

The fixture declares public inputs and expected results. The testkit owns runtimes, instances,
operation execution, HTTP requests, daemon restarts, assertions, and cleanup. Core cases cover:

- side-effect-free import and valid config export;
- config, seed, operation input, and operation output validation;
- operation introspection and unique generated CLI representations;
- lifecycle ordering and failed-create/update recovery;
- two-instance state and Hono-context isolation;
- instance-correct connection values and environment collision detection;
- tracked fetch work, reset, seed, and storage containment;
- restart persistence, real-version upgrade, and future-version rejection.

Optional cases cover recovery of committed time advancement and pending durable delivery. They are
included only when the fixture declares those behaviors.

## Keep the harness honest

Every base, fault, and historical-version variant must call the production plugin factory and keep
the same plugin ID, selected service key, and public operation inventory. Vary only narrow injected
dependencies or lifecycle version/failure configuration. Do not add test-only routes, operations,
or response fields.

The authoring config must be importable without starting a runtime, changing cwd or environment,
writing files, keeping process resources open, or printing output. The durability config runs in a
real daemon process and must construct the same plugin family from the testkit-provided fixture
environment.

Use production operations to arrange and inspect state. Use the public Hono route to prove HTTP
instance selection. Do not read plugin storage or repositories directly from the fixture.

## Version requirements

The durability fixture requires positive versions ordered `old < current < future`. The old version
must correspond to real historical storage. A new state-version-1 plugin has no honest predecessor;
use focused public-surface and lifecycle tests until a genuine upgrade path exists.

The shared contract proves runtime integration, not provider compatibility. Keep semantic API/SDK,
domain, persistence, signature, retry, and unsupported-boundary tests in the plugin package.

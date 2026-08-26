import type { ServiceRecord } from "localhost2137";
import { authoringCase } from "./authoring-probe.js";
import type { PluginContractCase, PluginContractFixture } from "./contract-types.js";
import { durabilityCases } from "./durability-cases.js";
import { validateFixture } from "./fixture-validation.js";
import { inProcessCases } from "./in-process-cases.js";
import { lifecycleFaultCases } from "./lifecycle-fault-cases.js";

export function createPluginContractCases<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): readonly PluginContractCase[] {
	validateFixture(fixture);
	const lifecycle = lifecycleFaultCases(fixture);
	const inProcess = inProcessCases(fixture);
	const durable = durabilityCases(fixture);
	return Object.freeze([
		authoringCase(fixture),
		requireCase(lifecycle, 0),
		requireCase(lifecycle, 1),
		requireCase(lifecycle, 2),
		requireCase(lifecycle, 3),
		requireCase(lifecycle, 4),
		requireCase(durable, 0),
		requireCase(inProcess, 0),
		requireCase(lifecycle, 5),
		requireCase(inProcess, 1),
		requireCase(inProcess, 2),
		requireCase(lifecycle, 6),
		requireCase(inProcess, 3),
		requireCase(inProcess, 4),
		requireCase(inProcess, 5),
		requireCase(durable, 1),
		requireCase(durable, 2),
		requireCase(durable, 3),
		...durable.slice(4),
	]);
}

export async function runPluginContract<Services extends ServiceRecord>(
	fixture: PluginContractFixture<Services>,
): Promise<void> {
	for (const contractCase of createPluginContractCases(fixture)) await contractCase.run();
}

function requireCase(cases: readonly PluginContractCase[], index: number): PluginContractCase {
	const contractCase = cases[index];
	if (!contractCase) throw new TypeError("Plugin contract case inventory is incomplete.");
	return contractCase;
}

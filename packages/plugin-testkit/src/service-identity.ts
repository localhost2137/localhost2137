import type { ServiceRecord } from "localhost2137";
import { assertContract, dataProperty, isPlainRecord } from "./contract-assertions.js";
import type { PluginContractFixture } from "./contract-types.js";

export interface ServiceDescriptionOwner {
	describeService(instanceId: string, serviceKey: string): Promise<unknown>;
}

export async function assertSelectedServiceIdentity<Services extends ServiceRecord>(
	owner: ServiceDescriptionOwner,
	instanceId: string,
	fixture: PluginContractFixture<Services>,
	caseName: string,
	stateVersion: number = fixture.harness.stateVersion,
): Promise<Readonly<Record<PropertyKey, unknown>>> {
	const description = await owner.describeService(instanceId, fixture.serviceKey);
	assertContract(isPlainRecord(description), caseName, "service description must be an object");
	if (!isPlainRecord(description)) return Object.freeze({});
	assertContract(
		dataProperty(description, "name") === fixture.serviceKey,
		caseName,
		"selected service key differs from public introspection",
	);
	assertContract(
		dataProperty(description, "pluginId") === fixture.harness.pluginId,
		caseName,
		"selected plugin id differs from public introspection",
	);
	assertContract(
		dataProperty(description, "stateVersion") === stateVersion,
		caseName,
		"selected stateVersion differs from public introspection",
	);
	const metadata = dataProperty(description, "operationMetadata");
	assertContract(isPlainRecord(metadata), caseName, "operationMetadata must be an object");
	if (!isPlainRecord(metadata)) return Object.freeze({});
	const actual = Object.keys(metadata).sort();
	const expected = fixture.operations.map(({ key }) => key).sort();
	assertContract(
		actual.length === expected.length && actual.every((key, index) => expected[index] === key),
		caseName,
		"selected operation inventory differs from the declared fixture inventory",
	);
	return metadata;
}

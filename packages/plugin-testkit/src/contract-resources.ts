import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { capture, finishCaptured } from "./cleanup-owner.js";
import type { ContractHarnessResources } from "./contract-types.js";

export interface OwnedContractResources {
	readonly deliveries: Readonly<{ count(): number; entered: Promise<void>; release(): void }>;
	readonly harness: ContractHarnessResources;
}

export async function withContractResources<Value>(
	input: Readonly<{ holdDelivery?: boolean }> | undefined,
	work: (resources: OwnedContractResources) => Promise<Value>,
): Promise<Value> {
	const entered = deferred();
	const release = deferred();
	let deliveries = 0;
	const server = createServer(async (_request, response) => {
		deliveries += 1;
		entered.resolve();
		if (input?.holdDelivery) await release.promise;
		response.writeHead(204).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address() as AddressInfo | null;
	if (!address) {
		server.close();
		throw new Error("Contract resource receiver has no TCP address.");
	}
	const resources: OwnedContractResources = Object.freeze({
		deliveries: Object.freeze({
			count: () => deliveries,
			entered: entered.promise,
			release: release.resolve,
		}),
		harness: Object.freeze({ deliveryUrl: `http://127.0.0.1:${address.port}/delivery` }),
	});
	const outcome = await capture(() => work(resources));
	release.resolve();
	const cleanupFailures: unknown[] = [];
	await new Promise<void>((resolve, reject) =>
		server.close((cause) => (cause ? reject(cause) : resolve())),
	).catch((cause: unknown) => cleanupFailures.push(cause));
	return finishCaptured(outcome, cleanupFailures, "Contract resource receiver");
}

function deferred() {
	let resolvePromise: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}

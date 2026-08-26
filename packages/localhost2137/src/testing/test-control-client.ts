import type {
	RuntimeClient,
	RuntimeClientCreateInput,
	RuntimeClientLogOptions,
	RuntimeClientRequestOptions,
} from "../client/runtime-client.js";
import type { ControlJsonValue } from "../control/control-client-errors.js";
import type { TestRuntimeGate } from "./test-instance-handle.js";

/** Keeps the exposed testing control client inside the runtime owner's state gate. */
export function createTestControlClient(
	client: RuntimeClient,
	runtime: TestRuntimeGate,
): RuntimeClient {
	const start = <Value>(operation: () => Promise<Value>): Promise<Value> => {
		try {
			runtime.assertOpen();
			return operation();
		} catch (cause) {
			return Promise.reject(cause);
		}
	};

	return Object.freeze({
		clockAdvance: (instanceId: string, duration: string, options?: RuntimeClientRequestOptions) =>
			start(() => client.clockAdvance(instanceId, duration, options)),
		clockStatus: (instanceId: string, options?: RuntimeClientRequestOptions) =>
			start(() => client.clockStatus(instanceId, options)),
		createInstance: (input: RuntimeClientCreateInput, options?: RuntimeClientRequestOptions) =>
			start(() => client.createInstance(input, options)),
		describeService: (
			instanceId: string,
			serviceKey: string,
			options?: RuntimeClientRequestOptions,
		) => start(() => client.describeService(instanceId, serviceKey, options)),
		destroyInstance: (instanceId: string, options?: RuntimeClientRequestOptions) =>
			start(() => client.destroyInstance(instanceId, options)),
		executeOperation: (
			instanceId: string,
			serviceKey: string,
			operationKey: string,
			input: ControlJsonValue,
			options?: RuntimeClientRequestOptions,
		) => start(() => client.executeOperation(instanceId, serviceKey, operationKey, input, options)),
		getInstance: (instanceId: string, options?: RuntimeClientRequestOptions) =>
			start(() => client.getInstance(instanceId, options)),
		health: (options?: RuntimeClientRequestOptions) => start(() => client.health(options)),
		idle: (
			instanceId: string,
			input?: Readonly<{ timeoutMs?: number }>,
			options?: RuntimeClientRequestOptions,
		) => start(() => client.idle(instanceId, input, options)),
		listInstances: (options?: RuntimeClientRequestOptions) =>
			start(() => client.listInstances(options)),
		listServices: (instanceId: string, options?: RuntimeClientRequestOptions) =>
			start(() => client.listServices(instanceId, options)),
		logs: (instanceId: string, options?: RuntimeClientLogOptions) =>
			start(() => client.logs(instanceId, options)),
		resetInstance: (
			instanceId: string,
			input?: Readonly<{ seed?: boolean }>,
			options?: RuntimeClientRequestOptions,
		) => start(() => client.resetInstance(instanceId, input, options)),
		seedInstance: (instanceId: string, options?: RuntimeClientRequestOptions) =>
			start(() => client.seedInstance(instanceId, options)),
		url: client.url,
	});
}

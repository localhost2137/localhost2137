import type { PluginLogger } from "../authoring/context.js";
import type { ReadonlyInstanceClock } from "./instance-clock.js";
import type { StructuredLogRing } from "./structured-log.js";

export class StructuredPluginLogger implements PluginLogger {
	readonly #clock: ReadonlyInstanceClock;
	readonly #instanceId: string;
	readonly #logs: StructuredLogRing;
	readonly #nextCorrelationId: () => string;
	readonly #now: () => string;
	readonly #serviceKey: string;

	constructor(input: {
		readonly clock: ReadonlyInstanceClock;
		readonly instanceId: string;
		readonly logs: StructuredLogRing;
		readonly nextCorrelationId: () => string;
		readonly now: () => string;
		readonly serviceKey: string;
	}) {
		this.#clock = input.clock;
		this.#instanceId = input.instanceId;
		this.#logs = input.logs;
		this.#nextCorrelationId = input.nextCorrelationId;
		this.#now = input.now;
		this.#serviceKey = input.serviceKey;
	}

	info(message: string, attributes?: Readonly<Record<string, unknown>>): void {
		this.#logs.append({
			...(attributes ? { attributes } : {}),
			correlationId: this.#nextCorrelationId(),
			instanceId: this.#instanceId,
			kind: "plugin",
			message,
			serviceKey: this.#serviceKey,
			status: "succeeded",
			virtualTime: this.#clock.now().toISOString(),
			wallTime: this.#now(),
		});
	}
}

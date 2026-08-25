import type { PluginClock } from "../authoring/context.js";
import type { MonotonicClock } from "./instance-leases.js";
import type { RuntimeTime } from "./runtime-time.js";
import type { StructuredLogRing } from "./structured-log.js";
import type { InstanceTaskTracker } from "./task-tracker.js";

type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class TrackedPluginFetch {
	readonly #clock: PluginClock;
	readonly #correlationId: () => string;
	readonly #fetch: FetchPort;
	readonly #instanceId: string;
	readonly #logs: StructuredLogRing;
	readonly #monotonicClock: MonotonicClock;
	readonly #serviceKey: string;
	readonly #tasks: InstanceTaskTracker;
	readonly #time: RuntimeTime;

	constructor(
		input: Readonly<{
			clock: PluginClock;
			correlationId: () => string;
			fetch: FetchPort;
			instanceId: string;
			logs: StructuredLogRing;
			monotonicClock: MonotonicClock;
			serviceKey: string;
			tasks: InstanceTaskTracker;
			time: RuntimeTime;
		}>,
	) {
		this.#clock = input.clock;
		this.#correlationId = input.correlationId;
		this.#fetch = input.fetch;
		this.#instanceId = input.instanceId;
		this.#logs = input.logs;
		this.#monotonicClock = input.monotonicClock;
		this.#serviceKey = input.serviceKey;
		this.#tasks = input.tasks;
		this.#time = input.time;
	}

	fetch: FetchPort = (input, init) => {
		const correlationId = this.#correlationId();
		const method = requestMethod(input, init);
		const target = safeTarget(input);
		const startedAt = this.#monotonicClock.nowMilliseconds();
		this.#append({
			attributes: { attempts: 1, method, target },
			correlationId,
			message: "Outbound delivery started.",
			status: "started",
		});
		return this.#tasks.start(`fetch:${this.#serviceKey}:${correlationId}`, () =>
			this.#fetch(input, init).then(
				(response) => {
					this.#append({
						attributes: { attempts: 1, method, responseStatus: response.status, target },
						correlationId,
						durationMs: elapsed(this.#monotonicClock.nowMilliseconds(), startedAt),
						message: "Outbound delivery succeeded.",
						status: "succeeded",
					});
					return response;
				},
				(cause: unknown) => {
					this.#append({
						attributes: { attempts: 1, error: errorName(cause), method, target },
						correlationId,
						durationMs: elapsed(this.#monotonicClock.nowMilliseconds(), startedAt),
						message: "Outbound delivery failed.",
						status: "failed",
					});
					throw cause;
				},
			),
		);
	};

	#append(
		input: Readonly<{
			attributes: Readonly<Record<string, unknown>>;
			correlationId: string;
			durationMs?: number;
			message: string;
			status: "failed" | "started" | "succeeded";
		}>,
	): void {
		this.#logs.append({
			attributes: input.attributes,
			correlationId: input.correlationId,
			...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
			instanceId: this.#instanceId,
			kind: "delivery",
			message: input.message,
			serviceKey: this.#serviceKey,
			status: input.status,
			virtualTime: this.#clock.now().toISOString(),
			wallTime: this.#time.nowTimestamp(),
		});
	}
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function safeTarget(input: RequestInfo | URL): string {
	try {
		const url = new URL(input instanceof Request ? input.url : input);
		return `${url.origin}${url.pathname}`;
	} catch {
		return "[INVALID_URL]";
	}
}

function errorName(cause: unknown): string {
	return cause instanceof Error && cause.name.trim() !== "" ? cause.name : "UnknownError";
}

function elapsed(finishedAt: number, startedAt: number): number {
	return Math.max(0, finishedAt - startedAt);
}

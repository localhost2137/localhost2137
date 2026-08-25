import { type Context, Hono } from "hono";
import { InstanceNotFoundError } from "../kernel/active-instance-registry.js";
import { InvalidIdentifierError } from "../kernel/identifiers.js";
import type { MonotonicClock } from "../kernel/instance-leases.js";
import type { RunningServiceLease } from "../kernel/instance-manager.js";
import type { RuntimeTime } from "../kernel/runtime-time.js";
import type { StructuredLogInput } from "../kernel/structured-log.js";
import type { PluginApiRegistry } from "./plugin-api-registry.js";
import { PluginApiWrappers } from "./plugin-api-wrapper.js";
import { responseWithFinalizer } from "./response-lifecycle.js";

export interface PublicGatewayRuntime {
	acquireService(
		instanceId: string,
		serviceKey: string,
		signal?: AbortSignal,
	): Promise<RunningServiceLease>;
}

export function createPublicGateway(
	input: Readonly<{
		apis: PluginApiRegistry;
		correlationId: () => string;
		monotonicClock: MonotonicClock;
		runtime: PublicGatewayRuntime;
		time: RuntimeTime;
	}>,
): Hono {
	const gateway = new PublicGateway(input);
	const app = new Hono();
	app.all("/:instance/:service", (context) => gateway.dispatch(context));
	app.all("/:instance/:service/*", (context) => gateway.dispatch(context));
	app.notFound(() =>
		publicError(404, "route_not_found", "Emulated instance or service not found."),
	);
	return app;
}

class PublicGateway {
	readonly #apis: PluginApiRegistry;
	readonly #correlationId: () => string;
	readonly #monotonicClock: MonotonicClock;
	readonly #runtime: PublicGatewayRuntime;
	readonly #time: RuntimeTime;
	readonly #wrappers = new PluginApiWrappers();

	constructor(
		input: Readonly<{
			apis: PluginApiRegistry;
			correlationId: () => string;
			monotonicClock: MonotonicClock;
			runtime: PublicGatewayRuntime;
			time: RuntimeTime;
		}>,
	) {
		this.#apis = input.apis;
		this.#correlationId = input.correlationId;
		this.#monotonicClock = input.monotonicClock;
		this.#runtime = input.runtime;
		this.#time = input.time;
	}

	async dispatch(context: Context): Promise<Response> {
		if (!isUnambiguousPublicPath(new URL(context.req.raw.url).pathname)) {
			return publicError(400, "invalid_route", "Invalid instance or service path.");
		}
		const instanceId = context.req.param("instance");
		const serviceKey = context.req.param("service");
		if (!instanceId || !serviceKey) {
			return publicError(404, "route_not_found", "Emulated instance or service not found.");
		}
		const api = this.#apis.resolve(serviceKey);
		if (!api) return publicError(404, "service_not_found", "Emulated service not found.");

		let lease: RunningServiceLease;
		try {
			lease = await this.#runtime.acquireService(instanceId, serviceKey, context.req.raw.signal);
		} catch (cause) {
			return publicResolutionError(cause);
		}

		let released = false;
		let responseOwnsLease = false;
		let correlationId: string | undefined;
		const releaseOnce = () => {
			if (released) return;
			released = true;
			lease.release();
		};
		try {
			const requestCorrelationId = this.#correlationId();
			correlationId = requestCorrelationId;
			const startedAt = this.#monotonicClock.nowMilliseconds();
			const requestAttributes = Object.freeze({
				method: context.req.method,
				path: context.req.path,
			});
			tryAppendRequestLog(lease, {
				attributes: requestAttributes,
				correlationId: requestCorrelationId,
				instanceId,
				kind: "request",
				message: "Public API request started.",
				serviceKey,
				status: "started",
				virtualTime: lease.context.clock.now().toISOString(),
				wallTime: this.#time.nowTimestamp(),
			});
			const request = rewritePublicRequest(context.req.raw);
			const wrapper = this.#wrappers.get(lease.generation, serviceKey, api);
			const response = await wrapper.fetch(request, {
				localhostContext: lease.context,
			});
			const ownedResponse = responseWithFinalizer(response, () => {
				try {
					tryAppendRequestLog(lease, {
						attributes: Object.freeze({
							...requestAttributes,
							...(responseSize(response) === undefined
								? {}
								: { responseBytes: responseSize(response) }),
							responseStatus: response.status,
						}),
							correlationId: requestCorrelationId,
						durationMs: elapsed(this.#monotonicClock.nowMilliseconds(), startedAt),
						instanceId,
						kind: "request",
						message: "Public API request completed.",
						serviceKey,
						status: response.status >= 500 ? "failed" : "succeeded",
						virtualTime: lease.context.clock.now().toISOString(),
						wallTime: this.#time.nowTimestamp(),
					});
				} finally {
					releaseOnce();
				}
			});
			responseOwnsLease = true;
			return ownedResponse;
		} catch (cause) {
			tryAppendRequestLog(lease, {
				attributes: Object.freeze({
					error: errorName(cause),
					method: context.req.method,
					path: context.req.path,
				}),
				correlationId: correlationId ?? safeCorrelationId(this.#correlationId),
				instanceId,
				kind: "request",
				message: "Public API request failed before a response was produced.",
				serviceKey,
				status: "failed",
				wallTime: safeTimestamp(this.#time),
			});
			return publicError(500, "plugin_request_failed", "Emulated service request failed.");
		} finally {
			if (!responseOwnsLease) releaseOnce();
		}
	}
}

function safeCorrelationId(correlationId: () => string): string {
	try {
		return correlationId();
	} catch {
		return "public-request-failure";
	}
}

function safeTimestamp(time: RuntimeTime): string {
	try {
		return time.nowTimestamp();
	} catch {
		return new Date(0).toISOString();
	}
}

function rewritePublicRequest(request: Request): Request {
	const url = new URL(request.url);
	const segments = url.pathname.split("/");
	if (segments.length < 3) throw new TypeError("Public route prefix is incomplete.");
	url.pathname = `/${segments.slice(3).join("/")}`;
	return new Request(url, request);
}

function publicResolutionError(cause: unknown): Response {
	if (cause instanceof InvalidIdentifierError) {
		return publicError(400, "invalid_route", "Invalid instance or service path.");
	}
	if (cause instanceof InstanceNotFoundError || isNamedError(cause, "ServiceNotFoundError")) {
		return publicError(404, "route_not_found", "Emulated instance or service not found.");
	}
	return publicError(503, "runtime_unavailable", "Emulated service is unavailable.");
}

function publicError(status: number, code: string, message: string): Response {
	return Response.json({ error: code, message }, { status });
}

function tryAppendRequestLog(lease: RunningServiceLease, input: StructuredLogInput): void {
	try {
		lease.logs.append(input);
	} catch {
		// Observability is best-effort at the adapter boundary. A malformed clock or
		// failing log sink must never retain the generation lease.
	}
}

function isUnambiguousPublicPath(pathname: string): boolean {
	for (const rawSegment of pathname.split("/")) {
		let decoded = rawSegment;
		for (let pass = 0; pass < 4; pass += 1) {
			let next: string;
			try {
				next = decodeURIComponent(decoded);
			} catch {
				return false;
			}
			if (next === decoded) break;
			decoded = next;
		}
		if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
			return false;
		}
	}
	return true;
}

function responseSize(response: Response): number | undefined {
	const value = response.headers.get("content-length");
	if (!value || !/^\d+$/.test(value)) return undefined;
	const size = Number(value);
	return Number.isSafeInteger(size) ? size : undefined;
}

function elapsed(finishedAt: number, startedAt: number): number {
	return Math.max(0, finishedAt - startedAt);
}

function errorName(cause: unknown): string {
	return cause instanceof Error && cause.name.trim() !== "" ? cause.name : "UnknownError";
}

function isNamedError(cause: unknown, name: string): cause is Error {
	return cause instanceof Error && cause.name === name;
}

import { Hono } from "hono";
import { LocalhostError } from "../authoring/localhost-error.js";
import type { InstanceSummary } from "../kernel/instance-manager.js";
import type { InstanceClockAdvanceResult } from "../kernel/durable-time-advancement.js";
import { ServiceNotFoundError } from "../kernel/instance-manager.js";
import type { OperationJsonValue } from "../kernel/operation-json.js";
import type { StructuredLogSnapshot } from "../kernel/structured-log.js";
import { ControlAuthenticator } from "./control-authentication.js";
import { controlErrorEnvelope, mapControlError } from "./control-error-mapping.js";
import {
	parseCreateInstance,
	parseClockAdvance,
	parseEmptyMutation,
	parseIdle,
	parseResetInstance,
} from "./control-input.js";
import {
	assertJsonMutation,
	CONTROL_BODY_LIMIT_BYTES,
	readControlJson,
} from "./control-request-body.js";
import type { ControlServiceCatalog } from "./control-service-catalog.js";

const LIFECYCLE_TIMEOUT_MS = 30_000;

type ControlEnvironment = { Variables: { correlationId: string } };

export interface ControlRuntime {
	advanceClock(
		id: string,
		duration: string,
		options: Readonly<{ signal?: AbortSignal; timeoutMs: number }>,
	): Promise<InstanceClockAdvanceResult>;
	create(
		options: Readonly<{
			id: string;
			persistence: "ephemeral" | "persistent";
			seed: boolean;
			signal?: AbortSignal;
			timeoutMs?: number;
		}>,
	): Promise<InstanceSummary>;
	destroy(
		id: string,
		options: Readonly<{ signal?: AbortSignal; timeoutMs: number }>,
	): Promise<void>;
	get(id: string): Promise<InstanceSummary>;
	idle(id: string, options: Readonly<{ signal?: AbortSignal; timeoutMs: number }>): Promise<void>;
	list(): Promise<readonly InstanceSummary[]>;
	logs(id: string): StructuredLogSnapshot;
	reset(
		id: string,
		options: Readonly<{ seed: boolean; signal?: AbortSignal; timeoutMs: number }>,
	): Promise<InstanceSummary>;
	seed(id: string, options: Readonly<{ signal?: AbortSignal; timeoutMs: number }>): Promise<void>;
}

export interface ControlOperationExecutor {
	execute(
		input: Readonly<{
			correlationId: string;
			instanceId: string;
			operationKey: string;
			rawInput: unknown;
			serviceKey: string;
			signal?: AbortSignal;
		}>,
	): Promise<OperationJsonValue>;
}

export function createControlApi(
	input: Readonly<{
		bodyLimitBytes?: number;
		catalog: ControlServiceCatalog;
		correlationId: () => string;
		operations: ControlOperationExecutor;
		runtime: ControlRuntime;
		token: string;
	}>,
): Hono<ControlEnvironment> {
	const app = new Hono<ControlEnvironment>();
	const authenticator = new ControlAuthenticator(input.token);
	const bodyLimitBytes = input.bodyLimitBytes ?? CONTROL_BODY_LIMIT_BYTES;

	app.use("*", async (context, next) => {
		context.set("correlationId", input.correlationId());
		await next();
	});
	app.get("/health", () => success({ status: "ok", version: "v1" }));
	app.use("*", async (context, next) => {
		authenticator.authenticate(context.req.raw);
		assertJsonMutation(context.req.raw);
		await next();
	});

	app.get("/instances", async () => success(await input.runtime.list()));
	app.post("/instances", async (context) => {
		const options = parseCreateInstance(await readControlJson(context.req.raw, bodyLimitBytes));
		const data = await input.runtime.create({
			...options,
			signal: context.req.raw.signal,
			timeoutMs: LIFECYCLE_TIMEOUT_MS,
		});
		return success(data, 201);
	});
	app.get("/instances/:instance", async (context) =>
		success(await input.runtime.get(requiredParam(context.req.param("instance")))),
	);
	app.delete("/instances/:instance", async (context) => {
		parseEmptyMutation(await readControlJson(context.req.raw, bodyLimitBytes));
		await input.runtime.destroy(requiredParam(context.req.param("instance")), {
			signal: context.req.raw.signal,
			timeoutMs: LIFECYCLE_TIMEOUT_MS,
		});
		return success(null);
	});
	app.post("/instances/:instance/reset", async (context) => {
		const options = parseResetInstance(await readControlJson(context.req.raw, bodyLimitBytes));
		return success(
			await input.runtime.reset(requiredParam(context.req.param("instance")), {
				...options,
				signal: context.req.raw.signal,
				timeoutMs: LIFECYCLE_TIMEOUT_MS,
			}),
		);
	});
	app.post("/instances/:instance/seed", async (context) => {
		parseEmptyMutation(await readControlJson(context.req.raw, bodyLimitBytes));
		await input.runtime.seed(requiredParam(context.req.param("instance")), {
			signal: context.req.raw.signal,
			timeoutMs: LIFECYCLE_TIMEOUT_MS,
		});
		return success(null);
	});

	app.get("/instances/:instance/services", async (context) => {
		await input.runtime.get(requiredParam(context.req.param("instance")));
		return success(input.catalog.list());
	});
	app.get("/instances/:instance/services/:service", async (context) => {
		const instanceId = requiredParam(context.req.param("instance"));
		const summary = await input.runtime.get(instanceId);
		const serviceKey = requiredParam(context.req.param("service"));
		const description = input.catalog.describe(serviceKey);
		if (!description) throw new ServiceNotFoundError(instanceId, serviceKey);
		const status = summary.services.find(({ key }) => key === serviceKey)?.status;
		if (!status) throw new ServiceNotFoundError(instanceId, serviceKey);
		return success({ ...description, status });
	});
	app.post("/instances/:instance/services/:service/operations/:operation", async (context) =>
		success(
			await input.operations.execute({
				correlationId: context.get("correlationId"),
				instanceId: requiredParam(context.req.param("instance")),
				operationKey: requiredParam(context.req.param("operation")),
				rawInput: await readControlJson(context.req.raw, bodyLimitBytes),
				serviceKey: requiredParam(context.req.param("service")),
				signal: context.req.raw.signal,
			}),
		),
	);

	app.get("/instances/:instance/logs", (context) => {
		const snapshot = input.runtime.logs(requiredParam(context.req.param("instance")));
		return success(filterLogs(snapshot, context.req.query("service"), context.req.query("tail")));
	});
	app.get("/instances/:instance/clock", async (context) =>
		success((await input.runtime.get(requiredParam(context.req.param("instance")))).clock),
	);
	app.post("/instances/:instance/clock/advance", async (context) => {
		const advance = parseClockAdvance(await readControlJson(context.req.raw, bodyLimitBytes));
		return success(
			await input.runtime.advanceClock(
				requiredParam(context.req.param("instance")),
				advance.duration,
				{
					signal: context.req.raw.signal,
					timeoutMs: LIFECYCLE_TIMEOUT_MS,
				},
			),
		);
	});
	app.post("/instances/:instance/idle", async (context) => {
		const options = parseIdle(await readControlJson(context.req.raw, bodyLimitBytes));
		await input.runtime.idle(requiredParam(context.req.param("instance")), {
			...options,
			signal: context.req.raw.signal,
		});
		return success(null);
	});

	app.notFound((context) =>
		controlFailure(
			mapControlError(
				new LocalhostError("INVALID_REQUEST", "Control endpoint not found.", { status: 404 }),
				context.get("correlationId"),
			),
		),
	);
	app.onError((cause, context) =>
		controlFailure(mapControlError(cause, context.get("correlationId"))),
	);
	return app;
}

function success(data: unknown, status: number = 200): Response {
	return Response.json({ data }, { status });
}

function controlFailure(error: ReturnType<typeof mapControlError>): Response {
	return Response.json(controlErrorEnvelope(error), { status: error.status });
}

function requiredParam(value: string | undefined): string {
	if (value) return value;
	throw new Error("A matched control route omitted a required parameter.");
}

function filterLogs(
	snapshot: StructuredLogSnapshot,
	serviceKey: string | undefined,
	rawTail: string | undefined,
): StructuredLogSnapshot {
	const tail = rawTail === undefined ? 50 : Number(rawTail);
	if (!Number.isSafeInteger(tail) || tail < 0 || tail > 1_000) {
		throw new LocalhostError(
			"INVALID_REQUEST",
			"Log tail must be a safe integer between 0 and 1000.",
			{ status: 400 },
		);
	}
	const matching = serviceKey
		? snapshot.entries.filter((entry) => entry.serviceKey === serviceKey)
		: snapshot.entries;
	return Object.freeze({
		droppedEntries: snapshot.droppedEntries,
		entries: Object.freeze(matching.slice(Math.max(0, matching.length - tail))),
	});
}

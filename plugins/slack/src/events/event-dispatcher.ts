import type { PluginClock, PluginLogger, TaskTracker } from "localhost2137";
import type { SlackConfig } from "../config.js";
import type { EventId, SlackMessage, SlackUser } from "../domain/models.js";
import type { SlackDatabase } from "../persistence/database.js";
import { createMessageEventEnvelope } from "./event-envelope.js";
import { signSlackRequest } from "./request-signature.js";

const DEFAULT_DELIVERY_TIMEOUT_MS = 3_000;

interface EventRuntimeContext {
	readonly clock: PluginClock;
	readonly log: PluginLogger;
	readonly signal: AbortSignal;
	readonly tasks: TaskTracker;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface EventDispatcherDependencies {
	readonly timeoutMs?: number;
	readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export class SlackEventDispatcher {
	readonly #config: SlackConfig;
	readonly #database: SlackDatabase;
	readonly #timeoutMs: number;
	readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

	constructor(
		database: SlackDatabase,
		config: SlackConfig,
		dependencies: EventDispatcherDependencies = {},
	) {
		this.#database = database;
		this.#config = config;
		this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
		this.#timeoutSignal = dependencies.timeoutSignal ?? AbortSignal.timeout;
	}

	schedule(
		context: EventRuntimeContext,
		input: Readonly<{ actor: SlackUser; eventId: EventId; message: SlackMessage }>,
	): void {
		const url = this.#config.eventsUrl;
		if (!url) return;
		const delivery = this.#deliver(context, url, input);
		void context.tasks.track(`Slack event ${input.eventId}`, delivery).catch(() => undefined);
	}

	async #deliver(
		context: EventRuntimeContext,
		url: string,
		input: Readonly<{ actor: SlackUser; eventId: EventId; message: SlackMessage }>,
	): Promise<void> {
		const startedAt = context.clock.now();
		this.#database.deliveries.startAttempt(input.eventId, startedAt);
		const body = JSON.stringify(
			createMessageEventEnvelope({
				actor: input.actor,
				eventId: input.eventId,
				message: input.message,
				workspace: this.#database.workspace.get(),
			}),
		);
		const timestamp = String(Math.floor(startedAt.getTime() / 1_000));
		const timeout = this.#timeoutSignal(this.#timeoutMs);
		const attemptSignal = AbortSignal.any([context.signal, timeout]);
		let response: Response;
		try {
			response = await context.fetch(url, {
				body,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"x-slack-request-timestamp": timestamp,
					"x-slack-signature": signSlackRequest({
						body,
						secret: this.#config.signingSecret,
						timestamp,
					}),
				},
				method: "POST",
				signal: attemptSignal,
			});
		} catch {
			const error = attemptTimedOut(attemptSignal, timeout) ? "timeout" : "transport_error";
			this.#completeFailure(context, input.eventId, { error });
			// ctx.fetch owns transport failure reporting. The outer tracked task
			// stays successful after the durable outcome is recorded.
			return;
		}
		try {
			await discardResponseBody(response.body, attemptSignal);
		} catch (cause) {
			const interrupted = cause instanceof DeliveryAttemptInterruptedError;
			const error = interrupted
				? attemptTimedOut(attemptSignal, timeout)
					? "timeout"
					: "transport_error"
				: "response_body_error";
			this.#completeFailure(context, input.eventId, {
				error,
				statusCode: response.status,
			});
			throw new Error(responseDisposalFailureMessage(error), { cause });
		}
		if (!response.ok) {
			this.#completeFailure(context, input.eventId, {
				error: "non_success_status",
				statusCode: response.status,
			});
			throw new Error(`Slack event delivery returned HTTP ${response.status}.`);
		}
		this.#database.deliveries.completeSuccess(input.eventId, {
			now: context.clock.now(),
			statusCode: response.status,
		});
		logDeliveryOutcome(context.log, {
			eventId: input.eventId,
			outcome: "succeeded",
			statusCode: response.status,
		});
	}

	#completeFailure(
		context: EventRuntimeContext,
		eventId: EventId,
		input: Readonly<{
			error: "non_success_status" | "response_body_error" | "timeout" | "transport_error";
			statusCode?: number;
		}>,
	): void {
		this.#database.deliveries.completeFailure(eventId, {
			error: input.error,
			now: context.clock.now(),
			...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
		});
		logDeliveryOutcome(context.log, {
			error: input.error,
			eventId,
			outcome: "failed",
			...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
		});
	}
}

async function discardResponseBody(
	body: ReadableStream<Uint8Array> | null,
	signal: AbortSignal,
): Promise<void> {
	if (!body) {
		throwIfDeliveryInterrupted(signal);
		return;
	}
	const disposal = Promise.resolve().then(() =>
		body.cancel("Slack Events callback response is not consumed."),
	);
	// The delivery deadline owns only the wait. A pathological cancellation may
	// settle later, and its rejection must remain handled after the attempt ends.
	void disposal.catch(() => undefined);
	await waitForDeliveryAttempt(disposal, signal);
	throwIfDeliveryInterrupted(signal);
}

function waitForDeliveryAttempt(work: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new DeliveryAttemptInterruptedError(signal.reason));
	let abort: (() => void) | undefined;
	const interruption = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new DeliveryAttemptInterruptedError(signal.reason));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	return Promise.race([work, interruption]).finally(() => {
		if (abort) signal.removeEventListener("abort", abort);
	});
}

function throwIfDeliveryInterrupted(signal: AbortSignal): void {
	if (signal.aborted) throw new DeliveryAttemptInterruptedError(signal.reason);
}

class DeliveryAttemptInterruptedError extends Error {
	constructor(cause: unknown) {
		super("Slack event delivery attempt was interrupted.", { cause });
		this.name = "DeliveryAttemptInterruptedError";
	}
}

function attemptTimedOut(attemptSignal: AbortSignal, timeoutSignal: AbortSignal): boolean {
	return timeoutSignal.aborted && attemptSignal.reason === timeoutSignal.reason;
}

function responseDisposalFailureMessage(
	error: "response_body_error" | "timeout" | "transport_error",
): string {
	if (error === "timeout") {
		return "Slack event delivery timed out while discarding its callback response body.";
	}
	if (error === "transport_error") {
		return "Slack event delivery was interrupted while discarding its callback response body.";
	}
	return "Slack event callback response body could not be discarded.";
}

function logDeliveryOutcome(
	logger: PluginLogger,
	input: Readonly<{
		error?: "non_success_status" | "response_body_error" | "timeout" | "transport_error";
		eventId: EventId;
		outcome: "failed" | "succeeded";
		statusCode?: number;
	}>,
): void {
	logger.info("Slack event delivery completed.", {
		...(input.error ? { error: input.error } : {}),
		eventId: input.eventId,
		outcome: input.outcome,
		...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
	});
}

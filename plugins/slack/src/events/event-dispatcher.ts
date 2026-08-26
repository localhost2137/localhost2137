import type { PluginClock, PluginLogger, TaskTracker } from "localhost2137";
import type { SlackConfig } from "../config.js";
import type { EventId, SlackMessage, SlackUser } from "../domain/models.js";
import type { SlackDatabase } from "../persistence/database.js";
import type { DueDeliveryAttempt } from "../persistence/delivery-repository.js";
import { createMessageEventEnvelope } from "./event-envelope.js";
import { signSlackRequest } from "./request-signature.js";
import { type DeliveryError, nextRetryDeadline, retryReasonFor } from "./retry-policy.js";

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

	async reconcileThrough(context: EventRuntimeContext, through: Date): Promise<void> {
		const url = this.#config.eventsUrl;
		if (!url) return;
		for (;;) {
			const attempt = this.#database.deliveries.dueAttempt(through);
			if (!attempt) return;
			const delivery = this.#database.deliveries.get(attempt.eventId);
			const message = this.#database.messages.getById(delivery.messageId);
			const actor = this.#database.users.getById(message.userId);
			await this.#deliver(context, url, { actor, message }, attempt, false);
		}
	}

	schedule(
		context: EventRuntimeContext,
		input: Readonly<{ actor: SlackUser; eventId: EventId; message: SlackMessage }>,
	): void {
		const url = this.#config.eventsUrl;
		if (!url) return;
		const attempt = Object.freeze({
			attempt: 1,
			eventId: input.eventId,
			retryReason: null,
			scheduledAt: context.clock.now(),
		});
		const delivery = this.#deliver(context, url, input, attempt, true);
		void context.tasks.track(`Slack event ${input.eventId}`, delivery).catch(() => undefined);
	}

	async #deliver(
		context: EventRuntimeContext,
		url: string,
		input: Readonly<{ actor: SlackUser; message: SlackMessage }>,
		attempt: DueDeliveryAttempt,
		surfaceCallbackFailure: boolean,
	): Promise<void> {
		const startedAt = context.clock.now();
		this.#database.deliveries.startAttempt(attempt.eventId, {
			...attempt,
			now: startedAt,
		});
		const body = JSON.stringify(
			createMessageEventEnvelope({
				actor: input.actor,
				eventId: attempt.eventId,
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
					...(attempt.retryReason
						? {
								"x-slack-retry-num": String(attempt.attempt - 1),
								"x-slack-retry-reason": attempt.retryReason,
							}
						: {}),
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
			this.#completeFailure(context, attempt, { error });
			// ctx.fetch owns transport failure reporting. The outer tracked task
			// stays successful after the durable outcome is recorded.
			return;
		}

		const suppressRetry = !response.ok && response.headers.get("x-slack-no-retry")?.trim() === "1";
		try {
			await discardResponseBody(response.body, attemptSignal);
		} catch (cause) {
			const interrupted = cause instanceof DeliveryAttemptInterruptedError;
			const error = interrupted
				? attemptTimedOut(attemptSignal, timeout)
					? "timeout"
					: "transport_error"
				: "response_body_error";
			this.#completeFailure(context, attempt, {
				error,
				statusCode: response.status,
				suppressRetry,
			});
			if (surfaceCallbackFailure) {
				throw new Error(responseDisposalFailureMessage(error), { cause });
			}
			return;
		}
		if (!response.ok) {
			this.#completeFailure(context, attempt, {
				error: "non_success_status",
				statusCode: response.status,
				suppressRetry,
			});
			if (surfaceCallbackFailure) {
				throw new Error(`Slack event delivery returned HTTP ${response.status}.`);
			}
			return;
		}
		this.#database.deliveries.completeSuccess(attempt.eventId, {
			attempt: attempt.attempt,
			now: context.clock.now(),
			statusCode: response.status,
		});
		logDeliveryOutcome(context.log, {
			attempt: attempt.attempt,
			eventId: attempt.eventId,
			outcome: "succeeded",
			statusCode: response.status,
		});
	}

	#completeFailure(
		context: EventRuntimeContext,
		attempt: DueDeliveryAttempt,
		input: Readonly<{
			error: DeliveryError;
			statusCode?: number;
			suppressRetry?: boolean;
		}>,
	): void {
		const retryReason = retryReasonFor(input.error);
		const nextAttemptAt = input.suppressRetry === true ? undefined : nextRetryDeadline(attempt);
		this.#database.deliveries.completeFailure(attempt.eventId, {
			attempt: attempt.attempt,
			error: input.error,
			...(nextAttemptAt ? { nextAttemptAt, retryReason } : {}),
			now: context.clock.now(),
			...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
		});
		logDeliveryOutcome(context.log, {
			attempt: attempt.attempt,
			error: input.error,
			eventId: attempt.eventId,
			...(nextAttemptAt ? { nextAttemptAt } : {}),
			outcome: "failed",
			...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
			suppressed: input.suppressRetry === true,
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
		attempt: number;
		error?: DeliveryError;
		eventId: EventId;
		nextAttemptAt?: Date;
		outcome: "failed" | "succeeded";
		statusCode?: number;
		suppressed?: boolean;
	}>,
): void {
	logger.info("Slack event delivery completed.", {
		attempt: input.attempt,
		...(input.error ? { error: input.error } : {}),
		eventId: input.eventId,
		...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt.toISOString() } : {}),
		outcome: input.outcome,
		...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
		...(input.suppressed ? { retrySuppressed: true } : {}),
	});
}

import type { PluginClock, PluginLogger, TaskTracker } from "localhost2137";
import type { StripeConfig } from "../config.js";
import type { EventId } from "../domain/models.js";
import type { StripeDatabase } from "../persistence/database.js";
import type { WebhookFailure } from "../persistence/webhook-repository.js";
import { createStripeEventEnvelope } from "./event-envelope.js";
import { signStripeWebhook } from "./signature.js";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 3_000;

interface WebhookRuntimeContext {
	readonly clock: PluginClock;
	readonly log: PluginLogger;
	readonly signal: AbortSignal;
	readonly tasks: TaskTracker;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WebhookDispatcherDependencies {
	readonly timeoutMs?: number;
	readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export class StripeWebhookDispatcher {
	readonly #config: StripeConfig;
	readonly #database: StripeDatabase;
	readonly #timeoutMs: number;
	readonly #timeoutSignal: (milliseconds: number) => AbortSignal;

	constructor(
		database: StripeDatabase,
		config: StripeConfig,
		dependencies: WebhookDispatcherDependencies = {},
	) {
		this.#config = config;
		this.#database = database;
		this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
		this.#timeoutSignal = dependencies.timeoutSignal ?? AbortSignal.timeout;
	}

	async reconcile(context: WebhookRuntimeContext, eventIds: readonly EventId[]): Promise<void> {
		if (!this.#config.webhookUrl) return;
		for (const eventId of eventIds) {
			context.signal.throwIfAborted();
			await this.#deliver(context, eventId);
		}
	}

	schedule(context: WebhookRuntimeContext, eventId: EventId): void {
		if (!this.#config.webhookUrl) return;
		const delivery = this.#deliver(context, eventId);
		void context.tasks.track(`Stripe webhook ${eventId}`, delivery).catch(() => undefined);
	}

	async #deliver(context: WebhookRuntimeContext, eventId: EventId): Promise<void> {
		const url = this.#config.webhookUrl;
		if (!url) return;
		const startedAt = context.clock.now();
		this.#database.webhooks.beginAttempt(eventId, startedAt);
		const event = this.#database.events.get(eventId);
		const invoice = this.#database.billing.getInvoice(event.invoiceId);
		const price = this.#database.catalog.getPrice(invoice.priceId);
		const body = JSON.stringify(createStripeEventEnvelope(event, invoice, price));
		const timestamp = String(Math.floor(startedAt.getTime() / 1_000));
		const timeout = this.#timeoutSignal(this.#timeoutMs);
		const attemptSignal = AbortSignal.any([context.signal, timeout]);
		let response: Response;
		try {
			response = await context.fetch(url, {
				body,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"stripe-signature": signStripeWebhook({
						body,
						secret: this.#config.webhookSecret,
						timestamp,
					}),
				},
				method: "POST",
				signal: attemptSignal,
			});
		} catch (cause) {
			if (context.signal.aborted) throw cause;
			this.#completeFailure(context, eventId, timeout.aborted ? "timeout" : "transport_error");
			return;
		}

		try {
			await discardResponse(response, attemptSignal);
		} catch (cause) {
			if (context.signal.aborted) throw cause;
			this.#completeFailure(
				context,
				eventId,
				timeout.aborted ? "timeout" : "transport_error",
				response.status,
			);
			return;
		}
		if (!response.ok) {
			this.#completeFailure(context, eventId, "non_success_status", response.status);
			return;
		}
		this.#database.webhooks.completeSuccess(eventId, {
			now: context.clock.now(),
			statusCode: response.status,
		});
		logOutcome(context.log, { eventId, outcome: "succeeded", statusCode: response.status });
	}

	#completeFailure(
		context: WebhookRuntimeContext,
		eventId: EventId,
		error: WebhookFailure,
		statusCode?: number,
	): void {
		this.#database.webhooks.completeFailure(eventId, {
			error,
			now: context.clock.now(),
			...(statusCode === undefined ? {} : { statusCode }),
		});
		logOutcome(context.log, {
			error,
			eventId,
			outcome: "failed",
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}
}

async function discardResponse(response: Response, signal: AbortSignal): Promise<void> {
	if (!response.body) {
		signal.throwIfAborted();
		return;
	}
	const cancellation = response.body.cancel("Stripe webhook response is not consumed.");
	void cancellation.catch(() => undefined);
	await waitFor(cancellation, signal);
}

function waitFor(work: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	let abort: (() => void) | undefined;
	const interruption = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	return Promise.race([work, interruption]).finally(() => {
		if (abort) signal.removeEventListener("abort", abort);
	});
}

function logOutcome(
	logger: PluginLogger,
	input: Readonly<{
		error?: WebhookFailure;
		eventId: EventId;
		outcome: "failed" | "succeeded";
		statusCode?: number;
	}>,
): void {
	logger.info("Stripe webhook delivery completed.", {
		...(input.error ? { error: input.error } : {}),
		eventId: input.eventId,
		outcome: input.outcome,
		...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
	});
}

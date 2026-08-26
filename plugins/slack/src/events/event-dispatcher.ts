import type { PluginClock, TaskTracker } from "localhost2137";
import type { SlackConfig } from "../config.js";
import type { EventId, SlackMessage, SlackUser } from "../domain/models.js";
import type { SlackDatabase } from "../persistence/database.js";
import { createMessageEventEnvelope } from "./event-envelope.js";
import { signSlackRequest } from "./request-signature.js";

const DEFAULT_DELIVERY_TIMEOUT_MS = 3_000;

interface EventRuntimeContext {
	readonly clock: PluginClock;
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
				signal: AbortSignal.any([context.signal, timeout]),
			});
		} catch {
			this.#database.deliveries.completeFailure(input.eventId, {
				error: timeout.aborted ? "timeout" : "transport_error",
				now: context.clock.now(),
			});
			// ctx.fetch owns transport failure reporting. The outer tracked task
			// stays successful after the durable outcome is recorded.
			return;
		}
		if (!response.ok) {
			this.#database.deliveries.completeFailure(input.eventId, {
				error: "non_success_status",
				now: context.clock.now(),
				statusCode: response.status,
			});
			throw new Error(`Slack event delivery returned HTTP ${response.status}.`);
		}
		this.#database.deliveries.completeSuccess(input.eventId, {
			now: context.clock.now(),
			statusCode: response.status,
		});
	}
}

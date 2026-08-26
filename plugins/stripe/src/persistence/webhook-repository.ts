import type Database from "better-sqlite3";
import type { EventId } from "../domain/models.js";

export type WebhookFailure = "non_success_status" | "timeout" | "transport_error";

export class WebhookRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	beginAttempt(eventId: EventId, now: Date): void {
		const delivery = this.#database
			.prepare("SELECT status FROM webhook_deliveries WHERE event_id = ?")
			.get(eventId) as { status: "failed" | "pending" | "succeeded" } | undefined;
		if (!delivery) throw new Error(`Stripe webhook delivery ${eventId} is missing.`);
		if (delivery.status !== "pending") {
			throw new Error(`Stripe webhook delivery ${eventId} is already terminal.`);
		}
		this.#database
			.prepare(
				`INSERT INTO webhook_delivery_attempts(event_id, started_at_ms)
				 VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING`,
			)
			.run(eventId, now.getTime());
		const attempt = this.#database
			.prepare("SELECT completed_at_ms FROM webhook_delivery_attempts WHERE event_id = ?")
			.get(eventId) as { completed_at_ms: number | null } | undefined;
		if (!attempt) throw new Error(`Stripe webhook delivery ${eventId} lost its attempt.`);
		if (attempt.completed_at_ms !== null) {
			throw new Error(`Stripe webhook delivery ${eventId} still schedules a completed attempt.`);
		}
	}

	completeFailure(
		eventId: EventId,
		input: Readonly<{ error: WebhookFailure; now: Date; statusCode?: number }>,
	): void {
		this.#complete(eventId, {
			error: input.error,
			now: input.now,
			status: "failed",
			statusCode: input.statusCode ?? null,
		});
	}

	completeSuccess(eventId: EventId, input: Readonly<{ now: Date; statusCode: number }>): void {
		this.#complete(eventId, {
			error: null,
			now: input.now,
			status: "succeeded",
			statusCode: input.statusCode,
		});
	}

	pendingIds(input: Readonly<{ advanceId?: string }> = {}): readonly EventId[] {
		const rows = (
			input.advanceId
				? this.#database
						.prepare(
							`SELECT e.id FROM events e
							 JOIN webhook_deliveries d ON d.event_id = e.id
							 JOIN resource_creation_order o
								ON o.kind = 'event' AND o.resource_id = e.id
							 WHERE d.status = 'pending' AND e.advance_id = ? ORDER BY o.ordinal`,
						)
						.all(input.advanceId)
				: this.#database
						.prepare(
							`SELECT e.id FROM events e
							 JOIN webhook_deliveries d ON d.event_id = e.id
							 JOIN resource_creation_order o
								ON o.kind = 'event' AND o.resource_id = e.id
							 WHERE d.status = 'pending' ORDER BY o.ordinal`,
						)
						.all()
		) as Array<{ id: string }>;
		return Object.freeze(rows.map(({ id }) => id));
	}

	#complete(
		eventId: EventId,
		input: Readonly<{
			error: WebhookFailure | null;
			now: Date;
			status: "failed" | "succeeded";
			statusCode: number | null;
		}>,
	): void {
		this.#database.transaction(() => {
			const attempt = this.#database
				.prepare(
					`UPDATE webhook_delivery_attempts
					 SET completed_at_ms = ?, status_code = ?, error = ?
					 WHERE event_id = ? AND completed_at_ms IS NULL`,
				)
				.run(input.now.getTime(), input.statusCode, input.error, eventId);
			if (attempt.changes !== 1) {
				throw new Error(`Stripe webhook delivery ${eventId} has no active attempt.`);
			}
			const delivery = this.#database
				.prepare(
					`UPDATE webhook_deliveries
					 SET status = ?, completed_at_ms = ?, status_code = ?, error = ?
					 WHERE event_id = ? AND status = 'pending'`,
				)
				.run(input.status, input.now.getTime(), input.statusCode, input.error, eventId);
			if (delivery.changes !== 1) {
				throw new Error(`Stripe webhook delivery ${eventId} is already terminal.`);
			}
		})();
	}
}

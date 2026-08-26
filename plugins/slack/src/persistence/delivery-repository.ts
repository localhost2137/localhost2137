import type Database from "better-sqlite3";
import type { EventDelivery, EventId, MessageId } from "../domain/models.js";
import { insertSequencedId } from "./id-sequence.js";

interface DeliveryRow {
	readonly completed_at_ms: number | null;
	readonly error: string | null;
	readonly event_id: string;
	readonly message_id: string;
	readonly requested_at_ms: number;
	readonly status: "failed" | "pending" | "succeeded";
	readonly status_code: number | null;
}

export class DeliveryRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	completeFailure(
		eventId: EventId,
		input: Readonly<{ error: string; now: Date; statusCode?: number }>,
	): void {
		this.#database
			.prepare(
				`UPDATE event_deliveries SET status = 'failed', completed_at_ms = ?, status_code = ?, error = ?
				 WHERE event_id = ?`,
			)
			.run(input.now.getTime(), input.statusCode ?? null, input.error, eventId);
		this.#database
			.prepare(
				`UPDATE event_delivery_attempts SET completed_at_ms = ?, status_code = ?, error = ?
				 WHERE event_id = ? AND attempt = 1`,
			)
			.run(input.now.getTime(), input.statusCode ?? null, input.error, eventId);
	}

	completeSuccess(eventId: EventId, input: Readonly<{ now: Date; statusCode: number }>): void {
		this.#database
			.prepare(
				`UPDATE event_deliveries SET status = 'succeeded', completed_at_ms = ?, status_code = ?, error = NULL
				 WHERE event_id = ?`,
			)
			.run(input.now.getTime(), input.statusCode, eventId);
		this.#database
			.prepare(
				`UPDATE event_delivery_attempts SET completed_at_ms = ?, status_code = ?, error = NULL
				 WHERE event_id = ? AND attempt = 1`,
			)
			.run(input.now.getTime(), input.statusCode, eventId);
	}

	enqueue(messageId: MessageId, now: Date): EventDelivery {
		const eventId = insertSequencedId(this.#database, "event", undefined, (allocatedId) => {
			this.#database
				.prepare(
					`INSERT INTO event_deliveries(event_id, message_id, status, requested_at_ms)
					 VALUES (?, ?, 'pending', ?)`,
				)
				.run(allocatedId, messageId, now.getTime());
		});
		return this.get(eventId);
	}

	get(eventId: EventId): EventDelivery {
		const row = this.#database
			.prepare(
				`SELECT event_id, message_id, status, requested_at_ms, completed_at_ms, status_code, error
				 FROM event_deliveries WHERE event_id = ?`,
			)
			.get(eventId) as DeliveryRow | undefined;
		if (!row) throw new Error(`Slack event delivery ${eventId} is missing.`);
		return toDelivery(row);
	}

	startAttempt(eventId: EventId, now: Date): void {
		this.#database
			.prepare(
				`INSERT INTO event_delivery_attempts(event_id, attempt, started_at_ms)
				 VALUES (?, 1, ?)`,
			)
			.run(eventId, now.getTime());
	}
}

function toDelivery(row: DeliveryRow): EventDelivery {
	return Object.freeze({
		completedAt: row.completed_at_ms === null ? null : new Date(row.completed_at_ms),
		error: row.error,
		eventId: row.event_id,
		messageId: row.message_id,
		requestedAt: new Date(row.requested_at_ms),
		status: row.status,
		statusCode: row.status_code,
	});
}

import type Database from "better-sqlite3";
import type { EventDelivery, EventId, MessageId } from "../domain/models.js";
import { insertSequencedId } from "./id-sequence.js";

export type SlackRetryReason =
	| "connection_failed"
	| "http_error"
	| "http_timeout"
	| "unknown_error";

export interface DueDeliveryAttempt {
	readonly attempt: number;
	readonly eventId: EventId;
	readonly retryReason: SlackRetryReason | null;
	readonly scheduledAt: Date;
}

interface DeliveryRow {
	readonly attempt_count: number;
	readonly completed_at_ms: number | null;
	readonly error: string | null;
	readonly event_id: string;
	readonly message_id: string;
	readonly next_attempt_at_ms: number | null;
	readonly requested_at_ms: number;
	readonly retry_reason: string | null;
	readonly status: "exhausted" | "pending" | "retry_scheduled" | "succeeded";
	readonly status_code: number | null;
}

export class DeliveryRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	completeFailure(
		eventId: EventId,
		input: Readonly<{
			attempt: number;
			error: string;
			nextAttemptAt?: Date;
			now: Date;
			retryReason?: SlackRetryReason;
			statusCode?: number;
		}>,
	): void {
		const retryScheduled = input.nextAttemptAt !== undefined;
		if (retryScheduled !== (input.retryReason !== undefined)) {
			throw new TypeError("A Slack retry deadline and retry reason must be stored together.");
		}
		this.#database.transaction(() => {
			this.#completeAttempt(eventId, input.attempt, {
				error: input.error,
				now: input.now,
				statusCode: input.statusCode ?? null,
			});
			const delivery = this.#database
				.prepare(
					`UPDATE event_deliveries
					 SET status = ?, completed_at_ms = ?, next_attempt_at_ms = ?,
					     status_code = ?, error = ?, retry_reason = ?
					 WHERE event_id = ? AND status IN ('pending', 'retry_scheduled')`,
				)
				.run(
					retryScheduled ? "retry_scheduled" : "exhausted",
					retryScheduled ? null : input.now.getTime(),
					input.nextAttemptAt?.getTime() ?? null,
					input.statusCode ?? null,
					input.error,
					input.retryReason ?? null,
					eventId,
				);
			if (delivery.changes !== 1) {
				throw new Error(`Slack event delivery ${eventId} is already terminal.`);
			}
		})();
	}

	completeSuccess(
		eventId: EventId,
		input: Readonly<{ attempt: number; now: Date; statusCode: number }>,
	): void {
		this.#database.transaction(() => {
			this.#completeAttempt(eventId, input.attempt, {
				error: null,
				now: input.now,
				statusCode: input.statusCode,
			});
			const delivery = this.#database
				.prepare(
					`UPDATE event_deliveries
					 SET status = 'succeeded', completed_at_ms = ?, next_attempt_at_ms = NULL,
					     status_code = ?, error = NULL, retry_reason = NULL
					 WHERE event_id = ? AND status IN ('pending', 'retry_scheduled')`,
				)
				.run(input.now.getTime(), input.statusCode, eventId);
			if (delivery.changes !== 1) {
				throw new Error(`Slack event delivery ${eventId} is already terminal.`);
			}
		})();
	}

	dueAttempt(through: Date): DueDeliveryAttempt | undefined {
		const row = this.#database
			.prepare(
				`SELECT
					d.event_id,
					COALESCE(
						MAX(CASE WHEN a.completed_at_ms IS NULL THEN a.attempt END),
						CASE d.status WHEN 'pending' THEN 1 ELSE COALESCE(MAX(a.attempt), 0) + 1 END
					) AS attempt,
					COALESCE(
						MAX(CASE WHEN a.completed_at_ms IS NULL THEN a.scheduled_at_ms END),
						CASE d.status WHEN 'pending' THEN d.requested_at_ms ELSE d.next_attempt_at_ms END
					) AS scheduled_at_ms,
					COALESCE(
						MAX(CASE WHEN a.completed_at_ms IS NULL THEN a.retry_reason END),
						d.retry_reason
					) AS retry_reason
				 FROM event_deliveries d
				 LEFT JOIN event_delivery_attempts a ON a.event_id = d.event_id
				 WHERE
					(d.status = 'pending' AND d.requested_at_ms <= ?)
					OR (d.status = 'retry_scheduled' AND d.next_attempt_at_ms <= ?)
				 GROUP BY d.event_id
				 ORDER BY scheduled_at_ms ASC, d.event_id ASC
				 LIMIT 1`,
			)
			.get(through.getTime(), through.getTime()) as
			| {
					attempt: number;
					event_id: string;
					retry_reason: SlackRetryReason | null;
					scheduled_at_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		return Object.freeze({
			attempt: row.attempt,
			eventId: row.event_id,
			retryReason: row.retry_reason,
			scheduledAt: new Date(row.scheduled_at_ms),
		});
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
				`SELECT
					d.event_id, d.message_id, d.status, d.requested_at_ms, d.completed_at_ms,
					d.next_attempt_at_ms, d.status_code, d.error, d.retry_reason,
					COUNT(a.id) AS attempt_count
				 FROM event_deliveries d
				 LEFT JOIN event_delivery_attempts a ON a.event_id = d.event_id
				 WHERE d.event_id = ?
				 GROUP BY d.event_id`,
			)
			.get(eventId) as DeliveryRow | undefined;
		if (!row) throw new Error(`Slack event delivery ${eventId} is missing.`);
		return toDelivery(row);
	}

	startAttempt(
		eventId: EventId,
		input: Readonly<{
			attempt: number;
			now: Date;
			retryReason: SlackRetryReason | null;
			scheduledAt: Date;
		}>,
	): void {
		const result = this.#database
			.prepare(
				`INSERT INTO event_delivery_attempts(
					event_id, attempt, scheduled_at_ms, started_at_ms, retry_reason
				 ) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(event_id, attempt) DO NOTHING`,
			)
			.run(
				eventId,
				input.attempt,
				input.scheduledAt.getTime(),
				input.now.getTime(),
				input.retryReason,
			);
		if (result.changes === 1) return;
		const existing = this.#database
			.prepare(
				`SELECT completed_at_ms FROM event_delivery_attempts
				 WHERE event_id = ? AND attempt = ?`,
			)
			.get(eventId, input.attempt) as { completed_at_ms: number | null } | undefined;
		if (!existing)
			throw new Error(`Slack event delivery ${eventId} lost attempt ${input.attempt}.`);
		if (existing.completed_at_ms !== null) {
			throw new Error(
				`Slack event delivery ${eventId} still schedules completed attempt ${input.attempt}.`,
			);
		}
	}

	#completeAttempt(
		eventId: EventId,
		attempt: number,
		input: Readonly<{ error: string | null; now: Date; statusCode: number | null }>,
	): void {
		const result = this.#database
			.prepare(
				`UPDATE event_delivery_attempts SET completed_at_ms = ?, status_code = ?, error = ?
				 WHERE event_id = ? AND attempt = ? AND completed_at_ms IS NULL`,
			)
			.run(input.now.getTime(), input.statusCode, input.error, eventId, attempt);
		if (result.changes !== 1) {
			throw new Error(`Slack event delivery ${eventId} has no active attempt ${attempt}.`);
		}
	}
}

function toDelivery(row: DeliveryRow): EventDelivery {
	return Object.freeze({
		attemptCount: row.attempt_count,
		completedAt: row.completed_at_ms === null ? null : new Date(row.completed_at_ms),
		error: row.error,
		eventId: row.event_id,
		messageId: row.message_id,
		nextAttemptAt: row.next_attempt_at_ms === null ? null : new Date(row.next_attempt_at_ms),
		requestedAt: new Date(row.requested_at_ms),
		retryReason: row.retry_reason,
		status: row.status,
		statusCode: row.status_code,
	});
}

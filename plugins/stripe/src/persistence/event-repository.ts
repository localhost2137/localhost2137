import type Database from "better-sqlite3";
import type { EventId, InvoiceId, StripeEvent } from "../domain/models.js";
import { insertStripeId } from "./id-sequence.js";

interface EventRow {
	readonly advance_id: string | null;
	readonly created_at_ms: number;
	readonly id: string;
	readonly invoice_id: string;
	readonly type: "invoice.paid" | "invoice.payment_failed";
}

export class EventRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	create(
		input: Readonly<{
			advanceId?: string;
			emitWebhook: boolean;
			invoiceId: InvoiceId;
			now: Date;
			type: StripeEvent["type"];
		}>,
	): StripeEvent {
		const id = insertStripeId(this.#database, "event", undefined, (allocatedId) => {
			this.#database
				.prepare(
					"INSERT INTO events(id, type, invoice_id, created_at_ms, advance_id) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					allocatedId,
					input.type,
					input.invoiceId,
					input.now.getTime(),
					input.advanceId ?? null,
				);
			if (input.emitWebhook) {
				this.#database
					.prepare(
						`INSERT INTO webhook_deliveries(event_id, status, requested_at_ms)
						 VALUES (?, 'pending', ?)`,
					)
					.run(allocatedId, input.now.getTime());
			}
		});
		return this.get(id);
	}

	get(id: EventId): StripeEvent {
		const row = this.#database
			.prepare("SELECT id, type, invoice_id, created_at_ms, advance_id FROM events WHERE id = ?")
			.get(id) as EventRow | undefined;
		if (!row) throw new Error(`Stripe event ${id} is missing after persistence.`);
		return toEvent(row);
	}

	list(input: Readonly<{ type?: StripeEvent["type"] }> = {}): readonly StripeEvent[] {
		const rows = (
			input.type
				? this.#database
						.prepare(
							`SELECT id, type, invoice_id, created_at_ms, advance_id
							 FROM events WHERE type = ? ORDER BY id`,
						)
						.all(input.type)
				: this.#database
						.prepare(
							"SELECT id, type, invoice_id, created_at_ms, advance_id FROM events ORDER BY id",
						)
						.all()
		) as EventRow[];
		return Object.freeze(rows.map(toEvent));
	}

	pendingIds(input: Readonly<{ advanceId?: string }> = {}): readonly EventId[] {
		const rows = (
			input.advanceId
				? this.#database
						.prepare(
							`SELECT e.id FROM events e
							 JOIN webhook_deliveries d ON d.event_id = e.id
							 WHERE d.status = 'pending' AND e.advance_id = ? ORDER BY e.id`,
						)
						.all(input.advanceId)
				: this.#database
						.prepare(
							`SELECT e.id FROM events e
							 JOIN webhook_deliveries d ON d.event_id = e.id
							 WHERE d.status = 'pending' ORDER BY e.id`,
						)
						.all()
		) as Array<{ id: string }>;
		return Object.freeze(rows.map(({ id }) => id));
	}
}

function toEvent(row: EventRow): StripeEvent {
	return Object.freeze({
		advanceId: row.advance_id,
		createdAt: new Date(row.created_at_ms),
		id: row.id,
		invoiceId: row.invoice_id,
		type: row.type,
	});
}

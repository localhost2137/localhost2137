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
		const event = this.find(id);
		if (!event) throw new Error(`Stripe event ${id} is missing after persistence.`);
		return event;
	}

	find(id: EventId): StripeEvent | undefined {
		const row = this.#database.prepare(`${eventSelect} WHERE e.id = ?`).get(id) as
			| EventRow
			| undefined;
		return row ? toEvent(row) : undefined;
	}

	list(input: Readonly<{ type?: StripeEvent["type"] }> = {}): readonly StripeEvent[] {
		const rows = (
			input.type
				? this.#database
						.prepare(`${eventSelect} WHERE e.type = ? ORDER BY o.ordinal`)
						.all(input.type)
				: this.#database.prepare(`${eventSelect} ORDER BY o.ordinal`).all()
		) as EventRow[];
		return Object.freeze(rows.map(toEvent));
	}
}

const eventSelect = `SELECT e.id, e.type, e.invoice_id, e.created_at_ms, e.advance_id
FROM events e
JOIN resource_creation_order o ON o.kind = 'event' AND o.resource_id = e.id`;

function toEvent(row: EventRow): StripeEvent {
	return Object.freeze({
		advanceId: row.advance_id,
		createdAt: new Date(row.created_at_ms),
		id: row.id,
		invoiceId: row.invoice_id,
		type: row.type,
	});
}

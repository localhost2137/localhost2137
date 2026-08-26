import type Database from "better-sqlite3";
import type { CustomerId, StripeCustomer } from "../domain/models.js";
import { insertStripeId } from "./id-sequence.js";

interface CustomerRow {
	readonly created_at_ms: number;
	readonly email: string | null;
	readonly id: string;
	readonly name: string;
}

export class CustomerRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	create(
		input: Readonly<{ email?: string; id?: string; name: string; now: Date }>,
	): StripeCustomer {
		const id = insertStripeId(this.#database, "customer", input.id, (allocatedId) => {
			this.#database
				.prepare("INSERT INTO customers(id, name, email, created_at_ms) VALUES (?, ?, ?, ?)")
				.run(allocatedId, input.name, input.email ?? null, input.now.getTime());
		});
		return this.get(id);
	}

	find(id: CustomerId): StripeCustomer | undefined {
		const row = this.#database
			.prepare("SELECT id, name, email, created_at_ms FROM customers WHERE id = ?")
			.get(id) as CustomerRow | undefined;
		return row ? toCustomer(row) : undefined;
	}

	get(id: CustomerId): StripeCustomer {
		const customer = this.find(id);
		if (!customer) throw new Error(`Stripe customer ${id} is missing after persistence.`);
		return customer;
	}

	list(
		input: Readonly<{ afterId?: string; limit: number }> = { limit: 100 },
	): readonly StripeCustomer[] {
		const rows = (
			input.afterId
				? this.#database
						.prepare(
							"SELECT id, name, email, created_at_ms FROM customers WHERE id > ? ORDER BY id LIMIT ?",
						)
						.all(input.afterId, input.limit)
				: this.#database
						.prepare("SELECT id, name, email, created_at_ms FROM customers ORDER BY id LIMIT ?")
						.all(input.limit)
		) as CustomerRow[];
		return Object.freeze(rows.map(toCustomer));
	}
}

function toCustomer(row: CustomerRow): StripeCustomer {
	return Object.freeze({
		createdAt: new Date(row.created_at_ms),
		email: row.email,
		id: row.id,
		name: row.name,
	});
}

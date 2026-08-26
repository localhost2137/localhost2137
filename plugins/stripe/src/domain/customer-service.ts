import type { StripeDatabase } from "../persistence/database.js";
import type { StripeCustomer } from "./models.js";
import { StripeError } from "./stripe-error.js";

export class CustomerService {
	readonly #database: StripeDatabase;

	constructor(database: StripeDatabase) {
		this.#database = database;
	}

	create(
		input: Readonly<{ email?: string; id?: string; name: string; now: Date }>,
	): StripeCustomer {
		const name = input.name.trim();
		if (name.length === 0 || name.length > 200) {
			throw new StripeError(
				"invalid_argument",
				"Customer name must contain 1-200 characters.",
				"name",
			);
		}
		return this.#database.customers.create({ ...input, name });
	}

	list(input?: Readonly<{ afterId?: string; limit: number }>): readonly StripeCustomer[] {
		return this.#database.customers.list(input);
	}

	require(id: string): StripeCustomer {
		const customer = this.#database.customers.find(id);
		if (!customer) {
			throw new StripeError("customer_missing", `No such customer: '${id}'.`, "customer");
		}
		return customer;
	}
}

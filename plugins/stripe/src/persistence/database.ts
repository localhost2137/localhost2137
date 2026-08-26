import Database from "better-sqlite3";
import { BillingRepository } from "./billing-repository.js";
import { CatalogRepository } from "./catalog-repository.js";
import { CustomerRepository } from "./customer-repository.js";
import { EventRepository } from "./event-repository.js";
import { WebhookRepository } from "./webhook-repository.js";

export class StripeDatabase {
	readonly billing: BillingRepository;
	readonly catalog: CatalogRepository;
	readonly customers: CustomerRepository;
	readonly events: EventRepository;
	readonly webhooks: WebhookRepository;
	readonly #database: Database.Database;
	#closed = false;

	constructor(path: string) {
		this.#database = new Database(path);
		this.#database.pragma("foreign_keys = ON");
		this.#database.pragma("journal_mode = WAL");
		this.#database.pragma("busy_timeout = 5000");
		this.billing = new BillingRepository(this.#database);
		this.catalog = new CatalogRepository(this.#database);
		this.customers = new CustomerRepository(this.#database);
		this.events = new EventRepository(this.#database);
		this.webhooks = new WebhookRepository(this.#database);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}

	raw(): Database.Database {
		this.#assertOpen();
		return this.#database;
	}

	transaction<Result>(work: () => Result): Result {
		this.#assertOpen();
		return this.#database.transaction(work)();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Stripe database is closed.");
	}
}

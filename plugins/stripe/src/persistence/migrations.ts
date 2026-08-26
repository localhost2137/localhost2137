import type Database from "better-sqlite3";

export const CURRENT_DATABASE_VERSION = 2;

interface Migration {
	readonly version: number;
	apply(database: Database.Database): void;
}

const migrations: readonly Migration[] = [
	{
		version: 1,
		apply(database) {
			database.exec(`
				CREATE TABLE counters (
					kind TEXT PRIMARY KEY,
					value INTEGER NOT NULL CHECK (value >= 0)
				);
				CREATE TABLE customers (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT,
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE products (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					active INTEGER NOT NULL CHECK (active IN (0, 1)),
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE prices (
					id TEXT PRIMARY KEY,
					product_id TEXT NOT NULL REFERENCES products(id),
					currency TEXT NOT NULL CHECK (currency GLOB '[a-z][a-z][a-z]'),
					unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
					active INTEGER NOT NULL CHECK (active IN (0, 1)),
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE subscriptions (
					id TEXT PRIMARY KEY,
					item_id TEXT NOT NULL UNIQUE,
					customer_id TEXT NOT NULL REFERENCES customers(id),
					price_id TEXT NOT NULL REFERENCES prices(id),
					status TEXT NOT NULL CHECK (status IN ('active', 'canceled')),
					current_period_start_ms INTEGER NOT NULL,
					current_period_end_ms INTEGER NOT NULL,
					latest_invoice_id TEXT,
					created_at_ms INTEGER NOT NULL,
					canceled_at_ms INTEGER,
					CHECK (current_period_end_ms > current_period_start_ms),
					CHECK (
						(status = 'active' AND canceled_at_ms IS NULL)
						OR (status = 'canceled' AND canceled_at_ms IS NOT NULL)
					)
				);
				CREATE INDEX subscriptions_due
					ON subscriptions(current_period_end_ms, id) WHERE status = 'active';
				CREATE TABLE invoices (
					id TEXT PRIMARY KEY,
					subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
					customer_id TEXT NOT NULL REFERENCES customers(id),
					price_id TEXT NOT NULL REFERENCES prices(id),
					currency TEXT NOT NULL CHECK (currency GLOB '[a-z][a-z][a-z]'),
					amount_due INTEGER NOT NULL CHECK (amount_due >= 0),
					amount_paid INTEGER NOT NULL CHECK (amount_paid >= 0),
					status TEXT NOT NULL CHECK (status IN ('open', 'paid')),
					period_start_ms INTEGER NOT NULL,
					period_end_ms INTEGER NOT NULL,
					created_at_ms INTEGER NOT NULL,
					paid_at_ms INTEGER,
					CHECK (period_end_ms > period_start_ms),
					CHECK (
						(status = 'paid' AND paid_at_ms IS NOT NULL AND amount_paid = amount_due)
						OR (status = 'open' AND paid_at_ms IS NULL AND amount_paid = 0)
					),
					UNIQUE (subscription_id, period_end_ms)
				);
				CREATE INDEX invoices_customer_id_id ON invoices(customer_id, id);
				CREATE INDEX invoices_subscription_id_id ON invoices(subscription_id, id);
				CREATE TABLE events (
					id TEXT PRIMARY KEY,
					type TEXT NOT NULL CHECK (type IN ('invoice.paid', 'invoice.payment_failed')),
					invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE webhook_deliveries (
					event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
					status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
					requested_at_ms INTEGER NOT NULL,
					completed_at_ms INTEGER,
					status_code INTEGER,
					error TEXT
				);
				CREATE TABLE webhook_delivery_attempts (
					event_id TEXT PRIMARY KEY REFERENCES webhook_deliveries(event_id) ON DELETE CASCADE,
					started_at_ms INTEGER NOT NULL,
					completed_at_ms INTEGER,
					status_code INTEGER,
					error TEXT
				);
				CREATE TABLE next_payment_outcomes (
					subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
					outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed'))
				);
			`);
		},
	},
	{
		version: 2,
		apply(database) {
			database.exec(`
				ALTER TABLE events ADD COLUMN advance_id TEXT;
				CREATE INDEX events_advance_id_id ON events(advance_id, id);
				CREATE TABLE time_advances (
					advance_id TEXT PRIMARY KEY,
					from_ms INTEGER NOT NULL,
					to_ms INTEGER NOT NULL,
					processed_at_ms INTEGER NOT NULL,
					CHECK (to_ms > from_ms)
				);
			`);
		},
	},
];

export function migrateDatabase(database: Database.Database): void {
	const version = database.pragma("user_version", { simple: true });
	if (typeof version !== "number" || !Number.isSafeInteger(version)) {
		throw new TypeError("Stripe database returned an invalid schema version.");
	}
	if (version > CURRENT_DATABASE_VERSION) {
		throw new Error(
			`Stripe database schema ${version} is newer than supported schema ${CURRENT_DATABASE_VERSION}.`,
		);
	}
	const apply = database.transaction(() => {
		for (const migration of migrations) {
			if (migration.version <= version) continue;
			migration.apply(database);
			database.pragma(`user_version = ${migration.version}`);
		}
	});
	apply();
}

export function assertCurrentDatabaseVersion(database: Database.Database): void {
	const version = database.pragma("user_version", { simple: true });
	if (version !== CURRENT_DATABASE_VERSION) {
		throw new Error(
			`Stripe database schema ${String(version)} must be migrated to ${CURRENT_DATABASE_VERSION} before start.`,
		);
	}
}

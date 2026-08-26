import type Database from "better-sqlite3";

export type StripeSequenceKind =
	| "customer"
	| "event"
	| "invoice"
	| "price"
	| "product"
	| "subscription";

const prefixes: Readonly<Record<StripeSequenceKind, string>> = Object.freeze({
	customer: "cus_",
	event: "evt_",
	invoice: "in_",
	price: "price_",
	product: "prod_",
	subscription: "sub_",
});

export function insertStripeId(
	database: Database.Database,
	kind: StripeSequenceKind,
	explicitId: string | undefined,
	insert: (id: string) => void,
): string {
	if (explicitId) {
		insert(explicitId);
		reconcileStripeId(database, kind, explicitId);
		return explicitId;
	}
	const current = database.prepare("SELECT value FROM counters WHERE kind = ?").get(kind) as
		| { value: number }
		| undefined;
	const next = (current?.value ?? 0) + 1;
	if (!Number.isSafeInteger(next)) throw new RangeError(`Stripe ${kind} ID sequence is exhausted.`);
	database
		.prepare(
			`INSERT INTO counters(kind, value) VALUES (?, ?)
			 ON CONFLICT(kind) DO UPDATE SET value = excluded.value`,
		)
		.run(kind, next);
	const id = `${prefixes[kind]}${String(next).padStart(6, "0")}`;
	insert(id);
	return id;
}

export function reconcileStripeId(
	database: Database.Database,
	kind: StripeSequenceKind,
	id: string,
): void {
	const prefix = prefixes[kind];
	if (!id.startsWith(prefix)) return;
	const suffix = id.slice(prefix.length);
	if (!/^\d+$/.test(suffix)) return;
	const value = Number(suffix);
	if (!Number.isSafeInteger(value)) return;
	database
		.prepare(
			`INSERT INTO counters(kind, value) VALUES (?, ?)
			 ON CONFLICT(kind) DO UPDATE SET value = MAX(value, excluded.value)`,
		)
		.run(kind, value);
}

import type Database from "better-sqlite3";

const sequencePrefixes = Object.freeze({
	channel: "C",
	event: "Ev",
	message: "M",
	user: "U",
});

export type SequenceKind = keyof typeof sequencePrefixes;

/**
 * Allocates or reconciles an ID and inserts its row as one SQLite transaction.
 * Generated sequences start at one; zero remains available for installed identities such as U000000.
 */
export function insertSequencedId(
	database: Database.Database,
	kind: SequenceKind,
	explicitId: string | undefined,
	insert: (id: string) => void,
): string {
	return database.transaction(() => {
		const id = explicitId ?? allocateId(database, kind);
		insert(id);
		if (explicitId !== undefined) reconcileSequenceId(database, kind, explicitId);
		return id;
	})();
}

/** Reconciles a persisted explicit or migrated ID with its generated numeric series. */
export function reconcileSequenceId(
	database: Database.Database,
	kind: SequenceKind,
	id: string,
): void {
	const value = numericSeriesValue(kind, id);
	if (value === undefined) return;
	const current = readCounter(database, kind);
	if (current !== undefined && current >= value) return;
	writeCounter(database, kind, value);
}

function allocateId(database: Database.Database, kind: SequenceKind): string {
	const current = readCounter(database, kind) ?? 0;
	if (current >= Number.MAX_SAFE_INTEGER) {
		throw new RangeError(`Slack ${kind} ID sequence is exhausted.`);
	}
	const next = current + 1;
	writeCounter(database, kind, next);
	return `${sequencePrefixes[kind]}${String(next).padStart(6, "0")}`;
}

function numericSeriesValue(kind: SequenceKind, id: string): number | undefined {
	const prefix = sequencePrefixes[kind];
	if (!id.startsWith(prefix)) return undefined;
	const suffix = id.slice(prefix.length);
	if (!/^\d{6,}$/.test(suffix)) return undefined;
	const value = Number(suffix);
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(`Slack explicit ${kind} ID is outside the supported numeric series.`);
	}
	return value;
}

function readCounter(database: Database.Database, kind: SequenceKind): number | undefined {
	const row = database.prepare("SELECT value FROM counters WHERE kind = ?").get(kind);
	if (row === undefined) return undefined;
	if (!isCounterRow(row)) throw new Error(`Slack counter ${kind} did not return a safe value.`);
	return row.value;
}

function writeCounter(database: Database.Database, kind: SequenceKind, value: number): void {
	database
		.prepare(
			`INSERT INTO counters(kind, value) VALUES (?, ?)
			 ON CONFLICT(kind) DO UPDATE SET value = excluded.value`,
		)
		.run(kind, value);
}

function isCounterRow(value: unknown): value is Readonly<{ value: number }> {
	return (
		typeof value === "object" &&
		value !== null &&
		"value" in value &&
		typeof value.value === "number" &&
		Number.isSafeInteger(value.value) &&
		value.value >= 0
	);
}

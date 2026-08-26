import type Database from "better-sqlite3";

const prefixes: Readonly<Record<"channel" | "event" | "message" | "user", string>> = Object.freeze({
	channel: "C",
	event: "Ev",
	message: "M",
	user: "U",
});

export type SequenceKind = keyof typeof prefixes;

export function nextId(database: Database.Database, kind: SequenceKind): string {
	database
		.prepare(
			`INSERT INTO counters(kind, value) VALUES (?, 1)
			 ON CONFLICT(kind) DO UPDATE SET value = value + 1`,
		)
		.run(kind);
	const row = database.prepare("SELECT value FROM counters WHERE kind = ?").get(kind);
	if (!isCounterRow(row)) throw new Error(`Slack counter ${kind} did not return a value.`);
	return `${prefixes[kind]}${String(row.value).padStart(6, "0")}`;
}

function isCounterRow(value: unknown): value is Readonly<{ value: number }> {
	return (
		typeof value === "object" &&
		value !== null &&
		"value" in value &&
		typeof value.value === "number" &&
		Number.isSafeInteger(value.value)
	);
}

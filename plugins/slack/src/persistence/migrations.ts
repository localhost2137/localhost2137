import type Database from "better-sqlite3";
import {
	MAX_SLACK_TIMESTAMP_MICROSECONDS,
	parseSlackTimestamp,
} from "../domain/slack-timestamp.js";
import { LOCAL_BOT_NAME, LOCAL_BOT_USER_ID } from "../slack-identities.js";
import { insertSequencedId, reconcileSequenceId, type SequenceKind } from "./id-sequence.js";

export const CURRENT_DATABASE_VERSION = 5;

interface Migration {
	readonly version: number;
	apply(database: Database.Database): void;
}

const migrations: readonly Migration[] = [
	{
		version: 1,
		apply(database) {
			database.exec(`
				CREATE TABLE workspace (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					bot_user_id TEXT NOT NULL
				);
				CREATE TABLE counters (
					kind TEXT PRIMARY KEY,
					value INTEGER NOT NULL CHECK (value >= 0)
				);
				CREATE TABLE users (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL UNIQUE,
					is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
					is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE tokens (
					token TEXT PRIMARY KEY,
					user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					kind TEXT NOT NULL CHECK (kind IN ('bot', 'user'))
				);
				CREATE TABLE channels (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL UNIQUE,
					is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE channel_memberships (
					channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
					user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					PRIMARY KEY (channel_id, user_id)
				);
				CREATE TABLE messages (
					id TEXT PRIMARY KEY,
					channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
					user_id TEXT NOT NULL REFERENCES users(id),
					text TEXT NOT NULL,
					ts TEXT NOT NULL UNIQUE,
					created_at_ms INTEGER NOT NULL
				);
				CREATE INDEX messages_channel_id_id ON messages(channel_id, id DESC);
			`);
			if (tableExists(database, "legacy_users")) {
				database.exec(`
					INSERT INTO users(id, name, is_admin, is_bot, created_at_ms)
					SELECT id, name, is_admin, 0, created_at_ms FROM legacy_users;
					DROP TABLE legacy_users;
				`);
			}
		},
	},
	{
		version: 2,
		apply(database) {
			database.exec(`
				ALTER TABLE messages ADD COLUMN thread_ts TEXT;
				ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
				CREATE TABLE event_deliveries (
					event_id TEXT PRIMARY KEY,
					message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
					status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
					requested_at_ms INTEGER NOT NULL,
					completed_at_ms INTEGER,
					status_code INTEGER,
					error TEXT
				);
				CREATE TABLE event_delivery_attempts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					event_id TEXT NOT NULL REFERENCES event_deliveries(event_id) ON DELETE CASCADE,
					attempt INTEGER NOT NULL CHECK (attempt = 1),
					started_at_ms INTEGER NOT NULL,
					completed_at_ms INTEGER,
					status_code INTEGER,
					error TEXT,
					UNIQUE (event_id, attempt)
				);
			`);
		},
	},
	{
		version: 3,
		apply(database) {
			reconcileRows(database, "user", "SELECT id FROM users");
			reconcileRows(database, "channel", "SELECT id FROM channels");
			reconcileRows(database, "message", "SELECT id FROM messages");
			reconcileRows(database, "event", "SELECT event_id AS id FROM event_deliveries");
		},
	},
	{
		version: 4,
		apply(database) {
			relocateReservedBotConflict(database);
			reserveCanonicalBotName(database);
		},
	},
	{
		version: 5,
		apply(database) {
			reconcileMessageTimestamps(database);
			database.exec(`
				CREATE INDEX messages_channel_ts_microseconds
				ON messages(channel_id, CAST(REPLACE(ts, '.', '') AS INTEGER) DESC);
			`);
		},
	},
];

export function migrateDatabase(database: Database.Database): void {
	const version = database.pragma("user_version", { simple: true });
	if (typeof version !== "number" || !Number.isSafeInteger(version)) {
		throw new TypeError("Slack database returned an invalid schema version.");
	}
	if (version > CURRENT_DATABASE_VERSION) {
		throw new Error(
			`Slack database schema ${version} is newer than supported schema ${CURRENT_DATABASE_VERSION}.`,
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
			`Slack database schema ${String(version)} must be migrated to ${CURRENT_DATABASE_VERSION} before start.`,
		);
	}
}

function tableExists(database: Database.Database, name: string): boolean {
	return (
		database
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(name) !== undefined
	);
}

function reconcileRows(database: Database.Database, kind: SequenceKind, query: string): void {
	const rows = database.prepare(query).all() as Array<{ id: string }>;
	for (const row of rows) reconcileSequenceId(database, kind, row.id);
}

function reconcileMessageTimestamps(database: Database.Database): void {
	const rows = database.prepare("SELECT id, ts FROM messages").all() as Array<{
		id: unknown;
		ts: unknown;
	}>;
	let maximum = 0n;
	const timestamps = new Set<bigint>();
	for (const row of rows) {
		if (typeof row.id !== "string" || typeof row.ts !== "string") {
			throw new Error("Slack persisted message timestamps must be stored as TEXT values.");
		}
		const timestamp = parseSlackTimestamp(row.ts);
		if (timestamp === undefined) {
			throw new Error(`Slack persisted message ${row.id} has invalid timestamp ${row.ts}.`);
		}
		if (timestamps.has(timestamp)) {
			throw new Error(
				`Slack persisted message ${row.id} duplicates timestamp ${row.ts} at microsecond precision.`,
			);
		}
		timestamps.add(timestamp);
		if (timestamp > maximum) maximum = timestamp;
	}

	const counter = readMessageTimestampCounter(database);
	const reconciled = counter !== undefined && counter > maximum ? counter : maximum;
	database
		.prepare(
			`INSERT INTO counters(kind, value) VALUES ('message_ts', ?)
			 ON CONFLICT(kind) DO UPDATE SET value = excluded.value`,
		)
		.run(reconciled);
}

function readMessageTimestampCounter(database: Database.Database): bigint | undefined {
	const row = database
		.prepare("SELECT value, typeof(value) AS storage_type FROM counters WHERE kind = 'message_ts'")
		.safeIntegers(true)
		.get() as { storage_type: unknown; value: unknown } | undefined;
	if (row === undefined) return undefined;
	if (
		row.storage_type !== "integer" ||
		typeof row.value !== "bigint" ||
		row.value < 0n ||
		row.value > MAX_SLACK_TIMESTAMP_MICROSECONDS
	) {
		throw new Error(
			"Slack message timestamp counter must be a non-negative SQLite INTEGER within the supported microsecond range.",
		);
	}
	return row.value;
}

interface PersistedUserIdentity {
	readonly created_at_ms: number;
	readonly is_admin: number;
	readonly is_bot: number;
	readonly name: string;
}

function relocateReservedBotConflict(database: Database.Database): void {
	const persisted = database
		.prepare("SELECT name, is_admin, is_bot, created_at_ms FROM users WHERE id = ?")
		.get(LOCAL_BOT_USER_ID) as PersistedUserIdentity | undefined;
	if (!persisted || isCanonicalBot(persisted)) return;

	const temporaryName = uniqueRelocationName(database);
	database.prepare("UPDATE users SET name = ? WHERE id = ?").run(temporaryName, LOCAL_BOT_USER_ID);
	const relocatedId = insertSequencedId(database, "user", undefined, (id) => {
		const preservedName =
			persisted.name === LOCAL_BOT_NAME ? uniquePreservedBotName(database, id) : persisted.name;
		database
			.prepare(
				"INSERT INTO users(id, name, is_admin, is_bot, created_at_ms) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, preservedName, persisted.is_admin, persisted.is_bot, persisted.created_at_ms);
	});
	for (const statement of [
		"UPDATE tokens SET user_id = ? WHERE user_id = ?",
		"UPDATE channel_memberships SET user_id = ? WHERE user_id = ?",
		"UPDATE messages SET user_id = ? WHERE user_id = ?",
		"UPDATE workspace SET bot_user_id = ? WHERE bot_user_id = ?",
	]) {
		database.prepare(statement).run(relocatedId, LOCAL_BOT_USER_ID);
	}
	const removed = database.prepare("DELETE FROM users WHERE id = ?").run(LOCAL_BOT_USER_ID);
	if (removed.changes !== 1) {
		throw new Error("Slack reserved bot identity conflict could not be relocated.");
	}
}

function isCanonicalBot(user: PersistedUserIdentity): boolean {
	return user.name === LOCAL_BOT_NAME && user.is_admin === 0 && user.is_bot === 1;
}

function reserveCanonicalBotName(database: Database.Database): void {
	const conflict = database
		.prepare("SELECT id FROM users WHERE name = ? AND id <> ?")
		.get(LOCAL_BOT_NAME, LOCAL_BOT_USER_ID) as { id: string } | undefined;
	if (!conflict) return;
	database
		.prepare("UPDATE users SET name = ? WHERE id = ?")
		.run(uniquePreservedBotName(database, conflict.id), conflict.id);
}

function uniquePreservedBotName(database: Database.Database, userId: string): string {
	let suffix = 0;
	while (true) {
		const qualifier = suffix === 0 ? "" : `-${suffix}`;
		const candidate = `${LOCAL_BOT_NAME}-preserved-${userId}${qualifier}`;
		const existing = database.prepare("SELECT 1 FROM users WHERE name = ?").get(candidate);
		if (existing === undefined) return candidate;
		suffix += 1;
	}
}

function uniqueRelocationName(database: Database.Database): string {
	let suffix = 0;
	while (true) {
		const candidate = `\u0000localhost2137:relocating:${suffix}`;
		const existing = database.prepare("SELECT 1 FROM users WHERE name = ?").get(candidate);
		if (existing === undefined) return candidate;
		suffix += 1;
	}
}

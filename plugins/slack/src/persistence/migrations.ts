import type Database from "better-sqlite3";
import { reconcileSequenceId, type SequenceKind } from "./id-sequence.js";

export const CURRENT_DATABASE_VERSION = 3;

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

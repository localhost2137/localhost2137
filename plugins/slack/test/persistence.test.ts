import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SlackService } from "../src/domain/slack-service.js";
import { SlackDatabase } from "../src/persistence/database.js";
import {
	assertCurrentDatabaseVersion,
	CURRENT_DATABASE_VERSION,
	migrateDatabase,
} from "../src/persistence/migrations.js";

const roots: string[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Slack persistence", () => {
	it("migrates a realistic version-0 numeric ID and reconciles the next user ID", async () => {
		const database = await fixtureDatabase();
		try {
			database
				.raw()
				.exec(await readFile(new URL("./fixtures/schema-v0.sql", import.meta.url), "utf8"));
			migrateDatabase(database.raw());
			assertCurrentDatabaseVersion(database.raw());
			expect(database.raw().pragma("user_version", { simple: true })).toBe(
				CURRENT_DATABASE_VERSION,
			);
			expect(database.users.findById("U000001")).toMatchObject({
				admin: true,
				bot: false,
				id: "U000001",
				name: "Legacy Ada",
			});
			const service = new SlackService(database);
			service.initialize(config(), now);
			expect(service.requireUser("U000000")).toMatchObject({
				admin: false,
				bot: true,
				id: "U000000",
				name: "localhost2137-bot",
			});
			expect(service.authenticate(config().botToken)).toMatchObject({
				bot: true,
				id: "U000000",
			});
			expect(service.createUser({ admin: false, name: "Grace", now }).id).toBe("U000002");
		} finally {
			database.close();
		}
	});

	it("relocates an already-migrated human bot-ID conflict while preserving references", async () => {
		const database = await versionTwoConflictDatabase();
		try {
			migrateDatabase(database.raw());
			expect(database.users.findById("U000000")).toBeUndefined();
			expect(database.users.findById("U000001")).toMatchObject({
				admin: true,
				bot: false,
				name: "Legacy Human",
			});
			expect(database.raw().prepare("SELECT user_id FROM channel_memberships").get()).toEqual({
				user_id: "U000001",
			});
			expect(database.raw().prepare("SELECT user_id FROM messages").get()).toEqual({
				user_id: "U000001",
			});
			expect(database.raw().prepare("SELECT user_id FROM tokens").get()).toEqual({
				user_id: "U000001",
			});
			expect(database.workspace.get()).toMatchObject({ botUserId: "U000001" });

			const service = new SlackService(database);
			service.initialize(config(), now);
			expect(service.requireUser("U000000")).toMatchObject({
				admin: false,
				bot: true,
				name: "localhost2137-bot",
			});
			expect(service.authenticate(config().botToken)).toMatchObject({
				bot: true,
				id: "U000000",
			});
			expect(() => service.authenticate("xoxb-stale-human-bot")).toThrow(/not valid/);
			expect(service.workspace()).toMatchObject({ botUserId: "U000000" });
			expect(service.createUser({ admin: false, name: "Next User", now }).id).toBe("U000002");
		} finally {
			database.close();
		}
	});

	it("rolls back reserved bot conflict relocation when a reference rewrite fails", async () => {
		const database = await versionTwoConflictDatabase();
		try {
			database.raw().exec(`
				CREATE TRIGGER reject_legacy_message_user_rewrite
				BEFORE UPDATE OF user_id ON messages
				BEGIN
					SELECT RAISE(ABORT, 'injected user reference rewrite failure');
				END;
			`);
			expect(() => migrateDatabase(database.raw())).toThrow(
				/injected user reference rewrite failure/,
			);
			expect(database.raw().pragma("user_version", { simple: true })).toBe(2);
			expect(database.users.findById("U000000")).toMatchObject({
				admin: true,
				bot: false,
				name: "Legacy Human",
			});
			expect(database.users.findById("U000001")).toBeUndefined();
			expect(database.raw().prepare("SELECT user_id FROM messages").get()).toEqual({
				user_id: "U000000",
			});
			expect(
				database.raw().prepare("SELECT value FROM counters WHERE kind = 'user'").get(),
			).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it("reconciles explicit numeric user and channel IDs without consuming semantic IDs", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			service.seed(
				{
					channels: [
						{ id: "C000004", members: ["U000003"], name: "numeric" },
						{ id: "C_GENERAL", members: ["U_ADA"], name: "semantic" },
					],
					users: [
						{ admin: false, id: "U000003", name: "Numeric Ada" },
						{ admin: false, id: "U_ADA", name: "Semantic Ada" },
					],
				},
				now,
			);

			expect(service.requireUser("U000000")).toMatchObject({ bot: true, id: "U000000" });
			expect(service.createUser({ admin: false, name: "Grace", now }).id).toBe("U000004");
			expect(service.createChannel({ name: "next", now }).id).toBe("C000005");
		} finally {
			database.close();
		}
	});

	it("rolls back generated ID allocation when its row insert fails", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			expect(database.users.create({ admin: false, name: "Taken", now })).toMatchObject({
				id: "U000001",
			});
			expect(() =>
				database.users.create({ admin: false, id: "U000099", name: "Taken", now }),
			).toThrow(/UNIQUE constraint failed/);
			expect(() => database.users.create({ admin: false, name: "Taken", now })).toThrow(
				/UNIQUE constraint failed/,
			);
			expect(database.users.create({ admin: false, name: "After failure", now })).toMatchObject({
				id: "U000002",
			});
		} finally {
			database.close();
		}
	});

	it("stores related world changes transactionally with deterministic IDs and timestamps", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const ada = service.createUser({ admin: true, name: "Ada", now });
			const channel = service.createChannel({ name: "General", now });
			service.addUserToChannel(channel.id, ada.id);

			const first = service.postMessage({
				channel: "general",
				emitEvent: true,
				now,
				text: "ping",
				user: ada.id,
			});
			const second = service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now,
				text: "pong",
				user: "U000000",
			});

			expect(ada.id).toBe("U000001");
			expect(channel.id).toBe("C000001");
			expect(first.message).toMatchObject({ id: "M000001", ts: "1767225600.000000" });
			expect(first.deliveryEventId).toBe("Ev000001");
			expect(second.message).toMatchObject({ id: "M000002", ts: "1767225600.000001" });
			expect(service.listMessages(channel.id, { limit: 100 }).map(({ text }) => text)).toEqual([
				"pong",
				"ping",
			]);
		} finally {
			database.close();
		}
	});

	it("rolls back message and event allocation when a write fails", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			expect(() =>
				service.postMessage({
					channel: channel.id,
					emitEvent: true,
					now,
					text: "from a missing user",
					user: "U404",
				}),
			).toThrow("not found");
			expect(service.listMessages(channel.id, { limit: 100 })).toEqual([]);
		} finally {
			database.close();
		}
	});

	it.each(["failure", "success"] as const)(
		"rolls back both delivery records when injected attempt %s completion fails",
		async (outcome) => {
			const database = await migratedDatabase();
			try {
				const service = new SlackService(database);
				service.initialize(config(), now);
				const channel = service.createChannel({ name: "general", now });
				const created = service.postMessage({
					channel: channel.id,
					emitEvent: true,
					now,
					text: "ping",
					user: "U000000",
				});
				const eventId = created.deliveryEventId;
				if (!eventId) throw new TypeError("Expected an event delivery fixture.");
				database.deliveries.startAttempt(eventId, now);
				database.raw().exec(`
					CREATE TRIGGER reject_delivery_attempt_completion
					BEFORE UPDATE OF completed_at_ms ON event_delivery_attempts
					BEGIN
						SELECT RAISE(ABORT, 'injected attempt completion failure');
					END;
				`);

				expect(() => {
					if (outcome === "success") {
						database.deliveries.completeSuccess(eventId, { now, statusCode: 204 });
					} else {
						database.deliveries.completeFailure(eventId, {
							error: "transport_error",
							now,
						});
					}
				}).toThrow(/injected attempt completion failure/);
				expect(database.deliveries.get(eventId)).toMatchObject({
					completedAt: null,
					error: null,
					status: "pending",
					statusCode: null,
				});
				expect(
					database
						.raw()
						.prepare(
							"SELECT completed_at_ms, error, status_code FROM event_delivery_attempts WHERE event_id = ?",
						)
						.get(eventId),
				).toEqual({ completed_at_ms: null, error: null, status_code: null });
			} finally {
				database.close();
			}
		},
	);

	it("rejects delivery completion without an active attempt and preserves pending state", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			const eventId = service.postMessage({
				channel: channel.id,
				emitEvent: true,
				now,
				text: "ping",
				user: "U000000",
			}).deliveryEventId;
			if (!eventId) throw new TypeError("Expected an event delivery fixture.");

			expect(() => database.deliveries.completeSuccess(eventId, { now, statusCode: 204 })).toThrow(
				/no active first attempt/,
			);
			expect(database.deliveries.get(eventId)).toMatchObject({
				completedAt: null,
				status: "pending",
			});
		} finally {
			database.close();
		}
	});
});

async function fixtureDatabase(): Promise<SlackDatabase> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-slack-"));
	roots.push(root);
	return new SlackDatabase(join(root, "slack.sqlite"));
}

async function migratedDatabase(): Promise<SlackDatabase> {
	const database = await fixtureDatabase();
	migrateDatabase(database.raw());
	return database;
}

async function versionTwoConflictDatabase(): Promise<SlackDatabase> {
	const database = await migratedDatabase();
	database.raw().exec(`
		INSERT INTO users(id, name, is_admin, is_bot, created_at_ms)
		VALUES ('U000000', 'Legacy Human', 1, 0, 1767225600000);
		INSERT INTO tokens(token, user_id, kind)
		VALUES ('xoxb-stale-human-bot', 'U000000', 'bot');
		INSERT INTO workspace(id, name, bot_user_id)
		VALUES ('T000001', 'Legacy Workspace', 'U000000');
		INSERT INTO channels(id, name, is_private, created_at_ms)
		VALUES ('C000001', 'legacy', 0, 1767225600000);
		INSERT INTO channel_memberships(channel_id, user_id)
		VALUES ('C000001', 'U000000');
		INSERT INTO messages(id, channel_id, user_id, text, ts, created_at_ms, thread_ts, deleted)
		VALUES (
			'M000001', 'C000001', 'U000000', 'legacy message',
			'1767225600.000000', 1767225600000, NULL, 0
		);
		PRAGMA user_version = 2;
	`);
	return database;
}

function config() {
	return {
		botToken: "xoxb-local-test",
		eventsUrl: null,
		signingSecret: "test-signing-secret",
		workspaceName: "Local Test",
	} as const;
}

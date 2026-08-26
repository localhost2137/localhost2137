import { mkdtemp, readFile, rm } from "node:fs/promises";
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

	it.each([
		{
			expectedHumanId: "U000001",
			expectedNextId: "U000002",
			persistedHumanId: "U000000",
		},
		{
			expectedHumanId: "U000007",
			expectedNextId: "U000008",
			persistedHumanId: "U000007",
		},
	] as const)(
		"reserves the canonical bot name when held by human $persistedHumanId",
		async ({ expectedHumanId, expectedNextId, persistedHumanId }) => {
			const database = await botNameConflictDatabase(persistedHumanId);
			try {
				migrateDatabase(database.raw());
				expect(database.users.findById(expectedHumanId)).toMatchObject({
					admin: true,
					bot: false,
					name: `localhost2137-bot-preserved-${expectedHumanId}`,
				});
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
				expect(service.createUser({ admin: false, name: "After conflict", now }).id).toBe(
					expectedNextId,
				);
			} finally {
				database.close();
			}
		},
	);

	it("rolls back canonical bot-name reservation failure", async () => {
		const database = await botNameConflictDatabase("U000007");
		try {
			database.raw().exec(`
				CREATE TRIGGER reject_bot_name_reservation
				BEFORE UPDATE OF name ON users
				WHEN OLD.id = 'U000007'
				BEGIN
					SELECT RAISE(ABORT, 'injected bot name reservation failure');
				END;
			`);
			expect(() => migrateDatabase(database.raw())).toThrow(
				/injected bot name reservation failure/,
			);
			expect(database.raw().pragma("user_version", { simple: true })).toBe(3);
			expect(database.users.findById("U000007")).toMatchObject({
				admin: true,
				bot: false,
				name: "localhost2137-bot",
			});
			expect(database.users.findById("U000000")).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it("uses a deterministic suffix when the preserved bot name is already taken", async () => {
		const database = await botNameConflictDatabase("U000007");
		try {
			database
				.raw()
				.prepare(
					"INSERT INTO users(id, name, is_admin, is_bot, created_at_ms) VALUES (?, ?, 0, 0, ?)",
				)
				.run("U000006", "localhost2137-bot-preserved-U000007", now.getTime());
			migrateDatabase(database.raw());
			expect(database.users.findById("U000007")?.name).toBe(
				"localhost2137-bot-preserved-U000007-1",
			);
		} finally {
			database.close();
		}
	});

	it.each([2, 3, 4] as const)(
		"reconciles a pre-counter version-%s database before same-instant restart writes",
		async (legacyVersion) => {
			const root = await mkdtemp(join(tmpdir(), "localhost2137-slack-"));
			roots.push(root);
			const path = join(root, "slack.sqlite");
			let database = new SlackDatabase(path);
			try {
				migrateDatabase(database.raw());
				const service = new SlackService(database);
				service.initialize(config(), now);
				const channel = service.createChannel({ name: "general", now });
				const first = service.postMessage({
					channel: channel.id,
					emitEvent: false,
					now,
					text: "before migration",
					user: "U000000",
				}).message;
				downgradeTimestampMigration(database, legacyVersion);
				database.raw().prepare("DELETE FROM counters WHERE kind = 'message_ts'").run();
				database.close();

				database = new SlackDatabase(path);
				migrateDatabase(database.raw());
				expect(messageTimestampCounter(database)).toBe(1_767_225_600_000_000n);
				database.close();

				database = new SlackDatabase(path);
				const restarted = new SlackService(database);
				restarted.initialize(config(), now);
				expect(
					restarted.postMessage({
						channel: channel.id,
						emitEvent: false,
						now,
						text: "after migration",
						user: "U000000",
					}).message,
				).toMatchObject({ id: "M000002", ts: "1767225600.000001" });
				expect(first.ts).toBe("1767225600.000000");
			} finally {
				database.close();
			}
		},
	);

	it.each([
		{ expected: 1_767_225_600_000_000n, name: "lower", value: 1n },
		{
			expected: 1_767_225_600_000_100n,
			name: "higher",
			value: 1_767_225_600_000_100n,
		},
	] as const)("keeps the $name timestamp reconciliation bound", async ({ expected, value }) => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now,
				text: "persisted",
				user: "U000000",
			});
			downgradeTimestampMigration(database, 4);
			database.raw().prepare("UPDATE counters SET value = ? WHERE kind = 'message_ts'").run(value);
			migrateDatabase(database.raw());
			expect(messageTimestampCounter(database)).toBe(expected);
		} finally {
			database.close();
		}
	});

	it("initializes an empty version-4 timestamp counter and exact ordering index", async () => {
		const database = await migratedDatabase();
		try {
			downgradeTimestampMigration(database, 4);
			database.raw().prepare("DELETE FROM counters WHERE kind = 'message_ts'").run();
			migrateDatabase(database.raw());
			expect(messageTimestampCounter(database)).toBe(0n);
			expect(
				database
					.raw()
					.prepare(
						"SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'messages_channel_ts_microseconds'",
					)
					.get(),
			).toEqual({ present: 1 });
		} finally {
			database.close();
		}
	});

	it.each(["not-a-timestamp", "9223372036854.775808"])(
		"rejects persisted message timestamp %s transactionally",
		async (timestamp) => {
			const database = await migratedDatabase();
			try {
				const service = new SlackService(database);
				service.initialize(config(), now);
				const channel = service.createChannel({ name: "general", now });
				const message = service.postMessage({
					channel: channel.id,
					emitEvent: false,
					now,
					text: "persisted",
					user: "U000000",
				}).message;
				downgradeTimestampMigration(database, 4);
				database
					.raw()
					.prepare("UPDATE messages SET ts = ? WHERE id = ?")
					.run(timestamp, message.id);
				expect(() => migrateDatabase(database.raw())).toThrow(
					new RegExp(`message ${message.id} has invalid timestamp`),
				);
				expect(database.raw().pragma("user_version", { simple: true })).toBe(4);
				expect(database.messages.getById(message.id).ts).toBe(timestamp);
				expect(timestampOrderingIndex(database)).toBeUndefined();
			} finally {
				database.close();
			}
		},
	);

	it("rejects duplicate persisted timestamps at exact microsecond precision", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now,
				text: "first",
				user: "U000000",
			});
			const second = service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now,
				text: "second",
				user: "U000000",
			}).message;
			downgradeTimestampMigration(database, 4);
			database
				.raw()
				.prepare("UPDATE messages SET ts = ? WHERE id = ?")
				.run("01767225600.000000", second.id);
			expect(() => migrateDatabase(database.raw())).toThrow(
				/duplicates timestamp 01767225600\.000000 at microsecond precision/,
			);
			expect(database.raw().pragma("user_version", { simple: true })).toBe(4);
			expect(timestampOrderingIndex(database)).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it.each([
		{ name: "REAL", value: 1.5 },
		{ name: "TEXT", value: "corrupt" },
		{ name: "out-of-range REAL", value: 1e30 },
	] as const)("rejects a $name timestamp counter with an invariant error", async ({ value }) => {
		const database = await migratedDatabase();
		try {
			downgradeTimestampMigration(database, 4);
			database.raw().prepare("UPDATE counters SET value = ? WHERE kind = 'message_ts'").run(value);
			expect(() => migrateDatabase(database.raw())).toThrow(
				/Slack message timestamp counter must be a non-negative SQLite INTEGER/,
			);
			expect(database.raw().pragma("user_version", { simple: true })).toBe(4);
			expect(timestampOrderingIndex(database)).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it("rolls back all version-5 changes when counter reconciliation fails", async () => {
		const database = await migratedDatabase();
		try {
			downgradeTimestampMigration(database, 4);
			database.raw().prepare("DELETE FROM counters WHERE kind = 'message_ts'").run();
			database.raw().exec(`
				CREATE TRIGGER reject_message_timestamp_counter
				BEFORE INSERT ON counters
				WHEN NEW.kind = 'message_ts'
				BEGIN
					SELECT RAISE(ABORT, 'injected timestamp reconciliation failure');
				END;
			`);
			expect(() => migrateDatabase(database.raw())).toThrow(
				/injected timestamp reconciliation failure/,
			);
			expect(database.raw().pragma("user_version", { simple: true })).toBe(4);
			expect(messageTimestampCounter(database)).toBeUndefined();
			expect(timestampOrderingIndex(database)).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it("rejects a future database without applying timestamp migration work", async () => {
		const database = await migratedDatabase();
		try {
			database.raw().pragma(`user_version = ${CURRENT_DATABASE_VERSION + 1}`);
			expect(() => migrateDatabase(database.raw())).toThrow(/newer than supported schema 5/);
			expect(database.raw().pragma("user_version", { simple: true })).toBe(6);
		} finally {
			database.close();
		}
	});

	it("orders and paginates exact timestamps across wide and semantic message IDs after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "localhost2137-slack-"));
		roots.push(root);
		const path = join(root, "slack.sqlite");
		let database = new SlackDatabase(path);
		try {
			migrateDatabase(database.raw());
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			database.raw().prepare("INSERT INTO counters(kind, value) VALUES ('message', 999998)").run();
			const narrow = database.messages.create({
				channelId: channel.id,
				now,
				text: "narrow numeric ID",
				userId: "U000000",
			});
			const wide = database.messages.create({
				channelId: channel.id,
				now,
				text: "wide numeric ID",
				userId: "U000000",
			});
			database
				.raw()
				.prepare(
					`INSERT INTO messages(
						id, channel_id, user_id, text, ts, created_at_ms, thread_ts, deleted
					) VALUES ('M_SEMANTIC', ?, 'U000000', ?, '1767225600.000002', ?, NULL, 0)`,
				)
				.run(channel.id, "semantic migrated ID", now.getTime());
			downgradeTimestampMigration(database, 2);
			database.close();

			database = new SlackDatabase(path);
			migrateDatabase(database.raw());
			const firstPage = database.messages.listPage(channel.id, { limit: 2 });
			const pageBoundary = firstPage.at(-1);
			if (!pageBoundary) throw new TypeError("Expected a timestamp page boundary.");
			const secondPage = database.messages.listPage(channel.id, {
				beforeTs: pageBoundary.ts,
				limit: 2,
			});
			expect(firstPage.map(({ id }) => id)).toEqual(["M_SEMANTIC", "M1000000"]);
			expect(secondPage.map(({ id }) => id)).toEqual(["M999999"]);
			expect([...firstPage, ...secondPage].map(({ id }) => id)).toEqual([
				"M_SEMANTIC",
				"M1000000",
				"M999999",
			]);
			expect(narrow).toMatchObject({ id: "M999999", ts: "1767225600.000000" });
			expect(wide).toMatchObject({ id: "M1000000", ts: "1767225600.000001" });
			expect(
				database.messages.listPage(channel.id, { limit: 10, oldest: wide.ts }).map(({ id }) => id),
			).toEqual(["M_SEMANTIC"]);
			expect(
				database.messages
					.listPage(channel.id, { inclusive: true, limit: 10, oldest: wide.ts })
					.map(({ id }) => id),
			).toEqual(["M_SEMANTIC", "M1000000"]);
			expect(
				database.messages.listPage(channel.id, { latest: wide.ts, limit: 10 }).map(({ id }) => id),
			).toEqual(["M999999"]);
			expect(
				database.messages
					.listPage(channel.id, { inclusive: true, latest: wide.ts, limit: 10 })
					.map(({ id }) => id),
			).toEqual(["M1000000", "M999999"]);
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

	it("allocates exact timestamps beyond Number safe-integer precision and across restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "localhost2137-slack-"));
		roots.push(root);
		const path = join(root, "slack.sqlite");
		const distantNow = new Date("2255-06-05T23:47:34.741Z");
		let database = new SlackDatabase(path);
		try {
			migrateDatabase(database.raw());
			const service = new SlackService(database);
			service.initialize(config(), distantNow);
			const channel = service.createChannel({ name: "general", now: distantNow });
			expect(
				service.postMessage({
					channel: channel.id,
					emitEvent: false,
					now: distantNow,
					text: "first",
					user: "U000000",
				}).message.ts,
			).toBe("9007199254.741000");
			expect(
				service.postMessage({
					channel: channel.id,
					emitEvent: false,
					now: distantNow,
					text: "second",
					user: "U000000",
				}).message.ts,
			).toBe("9007199254.741001");
			expect(messageTimestampCounter(database)).toBe(9_007_199_254_741_001n);

			database.close();
			database = new SlackDatabase(path);
			expect(
				database.messages.create({
					channelId: channel.id,
					now: distantNow,
					text: "after restart",
					userId: "U000000",
				}).ts,
			).toBe("9007199254.741002");
			expect(messageTimestampCounter(database)).toBe(9_007_199_254_741_002n);
		} finally {
			database.close();
		}
	});

	it("supports the maximum JavaScript Date without timestamp precision loss", async () => {
		const database = await migratedDatabase();
		const maximumDate = new Date(8_640_000_000_000_000);
		try {
			const service = new SlackService(database);
			service.initialize(config(), maximumDate);
			const channel = service.createChannel({ name: "general", now: maximumDate });
			const first = service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now: maximumDate,
				text: "first",
				user: "U000000",
			}).message;
			const second = service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now: maximumDate,
				text: "second",
				user: "U000000",
			}).message;
			expect(first.ts).toBe("8640000000000.000000");
			expect(second.ts).toBe("8640000000000.000001");
			expect(messageTimestampCounter(database)).toBe(8_640_000_000_000_000_001n);
		} finally {
			database.close();
		}
	});

	it("fails timestamp exhaustion without consuming a message ID", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			database
				.raw()
				.prepare("UPDATE counters SET value = ? WHERE kind = 'message_ts'")
				.run(9_223_372_036_854_775_807n);
			expect(() =>
				service.postMessage({
					channel: channel.id,
					emitEvent: false,
					now,
					text: "cannot allocate",
					user: "U000000",
				}),
			).toThrow(/timestamp sequence is exhausted/);
			expect(database.raw().prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({
				count: 0,
			});
			expect(
				database.raw().prepare("SELECT value FROM counters WHERE kind = 'message'").get(),
			).toBeUndefined();
			expect(messageTimestampCounter(database)).toBe(9_223_372_036_854_775_807n);
		} finally {
			database.close();
		}
	});

	it("rolls back timestamp and message counters when message persistence fails", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			expect(() =>
				database.messages.create({
					channelId: channel.id,
					now,
					text: "missing user",
					userId: "U404",
				}),
			).toThrow(/FOREIGN KEY constraint failed/);
			expect(messageTimestampCounter(database)).toBe(0n);
			expect(
				database.raw().prepare("SELECT value FROM counters WHERE kind = 'message'").get(),
			).toBeUndefined();
			expect(
				database.messages.create({
					channelId: channel.id,
					now,
					text: "valid",
					userId: "U000000",
				}),
			).toMatchObject({ id: "M000001", ts: "1767225600.000000" });
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
	`);
	downgradeTimestampMigration(database, 2);
	return database;
}

async function botNameConflictDatabase(userId: "U000000" | "U000007"): Promise<SlackDatabase> {
	const database = await migratedDatabase();
	database
		.raw()
		.prepare("INSERT INTO users(id, name, is_admin, is_bot, created_at_ms) VALUES (?, ?, 1, 0, ?)")
		.run(userId, "localhost2137-bot", now.getTime());
	database
		.raw()
		.prepare("INSERT INTO counters(kind, value) VALUES ('user', ?)")
		.run(userId === "U000000" ? 0 : 7);
	downgradeTimestampMigration(database, 3);
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

function messageTimestampCounter(database: SlackDatabase): bigint | undefined {
	const row = database
		.raw()
		.prepare("SELECT value FROM counters WHERE kind = 'message_ts'")
		.safeIntegers(true)
		.get() as { value: bigint } | undefined;
	return row?.value;
}

function downgradeTimestampMigration(database: SlackDatabase, version: 2 | 3 | 4): void {
	database.raw().exec("DROP INDEX IF EXISTS messages_channel_ts_microseconds");
	database.raw().pragma(`user_version = ${version}`);
}

function timestampOrderingIndex(database: SlackDatabase): unknown {
	return database
		.raw()
		.prepare(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'messages_channel_ts_microseconds'",
		)
		.get();
}

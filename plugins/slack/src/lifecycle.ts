import type { Lifecycle, RunningPluginContext } from "localhost2137";
import type { SlackConfig, SlackSeed } from "./config.js";
import { SlackService } from "./domain/slack-service.js";
import { SlackEventDispatcher } from "./events/event-dispatcher.js";
import type { SlackPluginDependencies } from "./plugin-dependencies.js";
import { SlackDatabase } from "./persistence/database.js";
import { assertCurrentDatabaseVersion, migrateDatabase } from "./persistence/migrations.js";
import type { SlackState } from "./state.js";

interface SlackTimeAdvance {
	readonly advanceId: string;
	readonly from: Date;
	readonly to: Date;
}

type SlackLifecycle = Lifecycle<SlackState, SlackConfig> & {
	readonly onTimeAdvanced: (
		context: RunningPluginContext<SlackState, SlackConfig>,
		advance: SlackTimeAdvance,
	) => Promise<void>;
	readonly seed: (
		context: RunningPluginContext<SlackState, SlackConfig>,
		seed: SlackSeed,
	) => Promise<void> | void;
};

export function createSlackLifecycle(dependencies: SlackPluginDependencies): SlackLifecycle {
	return {
		create(context) {
			dependencies.recordLifecycle?.("create");
			dependencies.beforeCreate?.(context);
			withDatabase(context.storage.path("slack.sqlite"), (database) => {
				migrateDatabase(database.raw());
				new SlackService(database).initialize(context.config, context.clock.now());
			});
		},
		onTimeAdvanced(context, advance) {
			return context.state.events.reconcileThrough(context, advance.to);
		},
		seed(context, seed) {
			dependencies.recordLifecycle?.("seed");
			context.state.service.seed(seed, context.clock.now());
		},
		start(context) {
			dependencies.recordLifecycle?.("start");
			const database = new SlackDatabase(context.storage.path("slack.sqlite"));
			try {
				assertCurrentDatabaseVersion(database.raw());
				const service = new SlackService(database);
				service.initialize(context.config, context.clock.now());
				return {
					database,
					events: new SlackEventDispatcher(database, context.config, {
						...(dependencies.deliveryTimeoutMs === undefined
							? {}
							: { timeoutMs: dependencies.deliveryTimeoutMs }),
					}),
					service,
				};
			} catch (cause) {
				database.close();
				throw cause;
			}
		},
		stop(context) {
			dependencies.recordLifecycle?.("stop");
			context.state.database.close();
		},
		update(context, version) {
			dependencies.recordLifecycle?.(`update:${version.from}:${version.to}`);
			withDatabase(context.storage.path("slack.sqlite"), (database) => {
				migrateDatabase(database.raw());
			});
		},
	};
}

function withDatabase(path: string, work: (database: SlackDatabase) => void): void {
	const database = new SlackDatabase(path);
	try {
		work(database);
	} finally {
		database.close();
	}
}

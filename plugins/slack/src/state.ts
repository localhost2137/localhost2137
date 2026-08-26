import type { SlackService } from "./domain/slack-service.js";
import type { SlackEventDispatcher } from "./events/event-dispatcher.js";
import type { SlackDatabase } from "./persistence/database.js";

export interface SlackState {
	readonly database: SlackDatabase;
	readonly events: SlackEventDispatcher;
	readonly service: SlackService;
}

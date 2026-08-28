import type { RunningPluginContext } from "localhost2137";
import type { SlackConfig } from "./config.js";
import type { CreatedMessage } from "./domain/slack-service.js";
import type { SlackState } from "./state.js";

export interface PostSlackMessageInput {
	readonly channel: string;
	readonly text: string;
	readonly threadTs?: string;
	readonly user: string;
}

/**
 * The single application command for message creation. Every adapter posts to
 * the same workspace and schedules the same Events API delivery behavior.
 */
export function postSlackMessage(
	context: RunningPluginContext<SlackState, SlackConfig>,
	input: PostSlackMessageInput,
): CreatedMessage {
	const actor = context.state.service.requireUser(input.user);
	const created = context.state.service.postMessage({
		channel: input.channel,
		emitEvent: context.config.eventsUrl !== null,
		now: context.clock.now(),
		text: input.text,
		...(input.threadTs ? { threadTs: input.threadTs } : {}),
		user: actor.id,
	});
	if (created.deliveryEventId) {
		context.state.events.schedule(context, {
			actor,
			eventId: created.deliveryEventId,
			message: created.message,
		});
	}
	return created;
}

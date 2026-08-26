import {
	defineOperation,
	LocalhostError,
	type OperationDefinition,
	type RunningPluginContext,
} from "localhost2137";
import { z } from "zod";
import type { SlackConfig } from "./config.js";
import { SlackError } from "./domain/slack-error.js";
import type { SlackPluginDependencies } from "./plugin-dependencies.js";
import type { SlackState } from "./state.js";

const bindOperation = defineOperation<"slack", SlackState, SlackConfig>();

const createUserInput: z.ZodObject<{
	admin: z.ZodDefault<z.ZodBoolean>;
	name: z.ZodString;
}> = z.object({
	admin: z.boolean().default(false),
	name: z.string().min(1).describe("Display name"),
});

const userOutput: z.ZodObject<{
	admin: z.ZodBoolean;
	id: z.ZodString;
	name: z.ZodString;
}> = z.object({
	admin: z.boolean(),
	id: z.string(),
	name: z.string(),
});

const createChannelInput: z.ZodObject<{ name: z.ZodString }> = z.object({
	name: z.string().min(1).describe("Channel name"),
});

const channelOutput: z.ZodObject<{ id: z.ZodString; name: z.ZodString }> = z.object({
	id: z.string(),
	name: z.string(),
});

const membershipInput: z.ZodObject<{ channel: z.ZodString; user: z.ZodString }> = z.object({
	channel: z.string().min(1).describe("Channel ID or exact name"),
	user: z.string().min(1).describe("User ID or exact name"),
});

const membershipOutput: z.ZodObject<{
	added: z.ZodBoolean;
	channel: z.ZodString;
	user: z.ZodString;
}> = z.object({ added: z.boolean(), channel: z.string(), user: z.string() });

const sendMessageInput: z.ZodObject<{
	channel: z.ZodString;
	from: z.ZodString;
	text: z.ZodString;
	threadTs: z.ZodOptional<z.ZodString>;
}> = z.object({
	channel: z.string().min(1).describe("Channel ID or exact name"),
	from: z.string().min(1).describe("User ID or exact name"),
	text: z.string().min(1),
	threadTs: z.string().optional(),
});

const listedMessageOutput: z.ZodObject<{
	channel: z.ZodString;
	id: z.ZodString;
	text: z.ZodString;
	threadTs: z.ZodNullable<z.ZodString>;
	ts: z.ZodString;
	userId: z.ZodString;
}> = z.object({
	channel: z.string(),
	id: z.string(),
	text: z.string(),
	threadTs: z.string().nullable(),
	ts: z.string(),
	userId: z.string(),
});

const sentMessageOutput: z.ZodObject<{
	channel: z.ZodString;
	eventId: z.ZodNullable<z.ZodString>;
	id: z.ZodString;
	text: z.ZodString;
	threadTs: z.ZodNullable<z.ZodString>;
	ts: z.ZodString;
	userId: z.ZodString;
}> = listedMessageOutput.extend({ eventId: z.string().nullable() });

const listMessagesInput: z.ZodObject<{
	channel: z.ZodString;
	limit: z.ZodDefault<z.ZodNumber>;
}> = z.object({
	channel: z.string().min(1).describe("Channel ID or exact name"),
	limit: z.number().int().min(1).max(999).default(100),
});

const messageListOutput: z.ZodArray<typeof listedMessageOutput> = z.array(listedMessageOutput);

type SlackBoundOperation<Input extends z.ZodObject, Output extends z.ZodType> = OperationDefinition<
	"slack",
	SlackState,
	SlackConfig,
	Input,
	Output
>;

interface SlackOperations {
	readonly addUserToChannel: SlackBoundOperation<typeof membershipInput, typeof membershipOutput>;
	readonly createChannel: SlackBoundOperation<typeof createChannelInput, typeof channelOutput>;
	readonly createUser: SlackBoundOperation<typeof createUserInput, typeof userOutput>;
	readonly listMessages: SlackBoundOperation<typeof listMessagesInput, typeof messageListOutput>;
	readonly sendMessage: SlackBoundOperation<typeof sendMessageInput, typeof sentMessageOutput>;
}

export function createSlackOperations(
	dependencies: SlackPluginDependencies,
): Readonly<SlackOperations> {
	const createUser = bindOperation({
		description: "Create a user in the local Slack workspace",
		input: createUserInput,
		output: userOutput,
		run: (context, input) =>
			runSlackOperation(dependencies, "createUser", context, () => {
				const user = context.state.service.createUser({
					admin: input.admin,
					name: input.name,
					now: context.clock.now(),
				});
				return { admin: user.admin, id: user.id, name: user.name };
			}),
	});

	const createChannel = bindOperation({
		description: "Create a public channel in the local Slack workspace",
		input: createChannelInput,
		output: channelOutput,
		run: (context, input) =>
			runSlackOperation(dependencies, "createChannel", context, () => {
				const channel = context.state.service.createChannel({
					name: input.name,
					now: context.clock.now(),
				});
				return { id: channel.id, name: channel.name };
			}),
	});

	const addUserToChannel = bindOperation({
		description: "Add a local Slack user to a channel",
		input: membershipInput,
		output: membershipOutput,
		run: (context, input) =>
			runSlackOperation(dependencies, "addUserToChannel", context, () =>
				context.state.service.addUserToChannel(input.channel, input.user),
			),
	});

	const sendMessage = bindOperation({
		description: "Send a user message and emit one local Slack Events API callback",
		input: sendMessageInput,
		output: sentMessageOutput,
		run: (context, input) =>
			runSlackOperation(dependencies, "sendMessage", context, () => {
				const actor = context.state.service.requireUser(input.from);
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
				return sentOperationMessage(created.message, created.deliveryEventId);
			}),
	});

	const listMessages = bindOperation({
		description: "Inspect messages in a local Slack channel",
		input: listMessagesInput,
		output: messageListOutput,
		run: (context, input) =>
			runSlackOperation(dependencies, "listMessages", context, () =>
				context.state.service
					.listMessages(input.channel, { limit: input.limit })
					.map(listedOperationMessage),
			),
	});

	return Object.freeze({
		addUserToChannel,
		createChannel,
		createUser,
		listMessages,
		sendMessage,
	});
}

function listedOperationMessage(
	message: Readonly<{
		channelId: string;
		id: string;
		text: string;
		threadTs: string | null;
		ts: string;
		userId: string;
	}>,
) {
	return {
		channel: message.channelId,
		id: message.id,
		text: message.text,
		threadTs: message.threadTs,
		ts: message.ts,
		userId: message.userId,
	};
}

function sentOperationMessage(
	message: Parameters<typeof listedOperationMessage>[0],
	eventId: string | null,
) {
	return { ...listedOperationMessage(message), eventId };
}

function runSlackOperation<Value>(
	dependencies: SlackPluginDependencies,
	operation: string,
	context: RunningPluginContext<SlackState, SlackConfig>,
	run: () => Value,
): Value {
	dependencies.beforeOperation?.(operation, context);
	try {
		return dependencies.transformOperationResult
			? dependencies.transformOperationResult(operation, run())
			: run();
	} catch (cause) {
		if (!(cause instanceof SlackError)) throw cause;
		throw new LocalhostError(`SLACK_${cause.code.toUpperCase()}`, cause.message, {
			cause,
			details: { slackError: cause.code },
			status: slackOperationStatus(cause),
		});
	}
}

function slackOperationStatus(error: SlackError): number {
	if (error.code === "channel_not_found" || error.code === "user_not_found") return 404;
	if (error.code === "name_taken" || error.code === "not_in_channel") return 409;
	return 400;
}

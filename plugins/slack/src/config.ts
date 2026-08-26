import { z } from "zod";

type SeededUserShape = {
	admin: z.ZodDefault<z.ZodBoolean>;
	id: z.ZodOptional<z.ZodString>;
	name: z.ZodString;
};

type SeededChannelShape = {
	id: z.ZodOptional<z.ZodString>;
	members: z.ZodDefault<z.ZodArray<z.ZodString>>;
	name: z.ZodString;
};

type SlackConfigShape = {
	botToken: z.ZodString;
	eventsUrl: z.ZodDefault<z.ZodNullable<z.ZodURL>>;
	signingSecret: z.ZodString;
	workspaceName: z.ZodString;
};

type SlackSeedShape = {
	channels: z.ZodDefault<z.ZodArray<z.ZodObject<SeededChannelShape>>>;
	users: z.ZodDefault<z.ZodArray<z.ZodObject<SeededUserShape>>>;
};

const seededUserSchema: z.ZodObject<SeededUserShape> = z.object({
	admin: z.boolean().default(false),
	id: z.string().min(1).optional(),
	name: z.string().trim().min(1),
});

const seededChannelSchema: z.ZodObject<SeededChannelShape> = z.object({
	id: z.string().min(1).optional(),
	members: z.array(z.string().min(1)).default([]),
	name: z.string().trim().min(1),
});

const slackConfigSchemaDefinition: z.ZodObject<SlackConfigShape> = z.object({
	botToken: z.string().startsWith("xoxb-"),
	eventsUrl: z.url().nullable().default(null),
	signingSecret: z.string().min(1),
	workspaceName: z.string().trim().min(1),
});

const slackSeedSchemaDefinition: z.ZodObject<SlackSeedShape> = z.object({
	channels: z.array(seededChannelSchema).default([]),
	users: z.array(seededUserSchema).default([]),
});

export const slackConfigSchema: typeof slackConfigSchemaDefinition = slackConfigSchemaDefinition;
export const slackSeedSchema: typeof slackSeedSchemaDefinition = slackSeedSchemaDefinition;
export type SlackConfig = z.output<typeof slackConfigSchema>;
export type SlackSeed = z.output<typeof slackSeedSchema>;

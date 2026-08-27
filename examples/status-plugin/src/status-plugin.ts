import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

const statusSchema = z.object({
	message: z.string().nullable(),
	state: z.enum(["operational", "degraded", "outage"]),
});
const setStatusInput = z.object({
	message: z.string().optional(),
	state: statusSchema.shape.state,
});

type Config = Readonly<Record<string, never>>;
type State = Readonly<{ statusPath: string }>;
type Status = z.output<typeof statusSchema>;

const initialStatus: Status = { message: null, state: "operational" };
const operation = defineOperation<"status", State, Config>();

const readStatus = operation({
	description: "Read the current status",
	input: z.object({}),
	output: statusSchema,
	run: (context) => loadStatus(context.state.statusPath),
});

const setStatus = operation({
	description: "Set the status exposed to the application",
	input: setStatusInput,
	output: statusSchema,
	run: async (context, input) => {
		const status: Status = {
			message: input.message ?? null,
			state: input.state,
		};
		await saveStatus(context.state.statusPath, status);
		return status;
	},
});

const api = new Hono<PluginEnv<State, Config>>();
api.get("/v1/status", async (context) => {
	const { state } = context.get("lh");
	return context.json(await loadStatus(state.statusPath));
});

export const statusPlugin = definePlugin({
	api,
	configSchema: z.object({}),
	connection: ({ baseUrl, instanceId, serviceKey }) => {
		const apiUrl = `${baseUrl}/${instanceId}/${serviceKey}`;
		return {
			env: { STATUS_API_URL: apiUrl },
			values: { apiUrl },
		};
	},
	description: "Local status service",
	id: "status",
	lifecycle: {
		create: (context) => saveStatus(context.storage.path("status.json"), initialStatus),
		start: (context): State => ({
			statusPath: context.storage.path("status.json"),
		}),
	},
	operations: { readStatus, setStatus },
	stateVersion: 1,
});

async function loadStatus(path: string): Promise<Status> {
	return statusSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function saveStatus(path: string, status: Status): Promise<void> {
	await writeFile(path, `${JSON.stringify(status)}\n`, "utf8");
}

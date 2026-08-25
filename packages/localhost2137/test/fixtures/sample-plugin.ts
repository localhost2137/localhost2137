import { Hono } from "hono";
import { z } from "zod";

const api = new Hono();
const configSchema = z.object({ greeting: z.string() });

/**
 * A Phase 0 fixture, not an implementation of the authoring API. It models the
 * only work a plugin module may perform during import: construct definitions.
 */
export const samplePlugin = Object.freeze({
	api,
	configSchema,
	id: "sample",
	stateVersion: 1,
});

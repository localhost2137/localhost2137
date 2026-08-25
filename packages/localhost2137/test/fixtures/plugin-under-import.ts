import { Hono } from "hono";
import { z } from "zod";

const api = new Hono();
const configSchema = z.object({ greeting: z.string() });

/**
 * Phase 0 baseline only: importing static Hono/Zod definitions must be inert.
 * Phase 1 replaces this object with a plugin authored through imports from the
 * real public `localhost2137` root; the surrounding smoke test stays unchanged.
 */
export const samplePlugin = Object.freeze({
	api,
	configSchema,
	id: "sample",
	stateVersion: 1,
});

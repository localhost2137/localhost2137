import { Hono } from "hono";
import type { PluginEnv } from "localhost2137";
import type { StripeConfig } from "../config.js";
import type { StripeState } from "../state.js";

export function createStripeApi(): Hono<PluginEnv<StripeState, StripeConfig>> {
	return new Hono<PluginEnv<StripeState, StripeConfig>>();
}

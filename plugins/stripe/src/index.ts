import { createStripePlugin, type StripePluginFactory } from "./plugin.js";

/** Configure a deterministic local Stripe account. Importing this package has no side effects. */
export const stripe: StripePluginFactory = createStripePlugin();

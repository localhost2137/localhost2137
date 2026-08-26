import { createStripePlugin, type StripePluginFactory } from "./plugin.js";

export { createStripeSdkFetch, type StripeSdkFetch } from "./sdk-fetch.js";
export { verifyStripeWebhookSignature } from "./webhooks/signature.js";

/** Configure a deterministic local Stripe account. Importing this package has no side effects. */
export const stripe: StripePluginFactory = createStripePlugin();

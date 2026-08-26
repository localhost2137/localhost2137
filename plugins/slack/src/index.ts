import { createSlackPlugin, type SlackPluginFactory } from "./plugin.js";

/** Configure a stateful local Slack workspace. Importing this package has no runtime side effects. */
export const slack: SlackPluginFactory = createSlackPlugin();

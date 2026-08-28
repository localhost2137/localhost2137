import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { PluginEnv } from "localhost2137";
import type { SlackConfig } from "../config.js";
import type { SlackState } from "../state.js";

const UI_ASSET_ROOT = fileURLToPath(new URL("../../assets/ui/", import.meta.url));
const INDEX_PATH = fileURLToPath(new URL("../../assets/ui/index.html", import.meta.url));
const BASE_MARKER = 'href="./" data-localhost2137-base';
const CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	"base-uri 'self'",
	"connect-src 'self'",
	"font-src 'self'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"img-src 'self' data:",
	"script-src 'self'",
	"style-src 'self'",
].join("; ");

type SlackUiContext = Context<PluginEnv<SlackState, SlackConfig>>;
type SlackUiApp = Hono<PluginEnv<SlackState, SlackConfig>>;

export interface SlackDashboardAssetDependencies {
	readonly readIndex: () => Promise<string>;
}

const defaultAssetDependencies: SlackDashboardAssetDependencies = Object.freeze({
	readIndex: () => readFile(INDEX_PATH, "utf8"),
});

let dashboardAssetMiddleware: Promise<
	MiddlewareHandler<PluginEnv<SlackState, SlackConfig>>
> | null = null;

export function registerSlackDashboardAssets(
	app: SlackUiApp,
	dependencies: SlackDashboardAssetDependencies = defaultAssetDependencies,
): void {
	app.on(["GET", "HEAD"], "/", (context) => dashboardIndex(context, dependencies));
	app.use("/assets/*", async (context, next) => {
		const serveDashboardAsset = await loadDashboardAssetMiddleware();
		const response = await serveDashboardAsset(context, next);
		if (!(response instanceof Response) || response.status >= 400) return;
		response.headers.set("cache-control", "public, max-age=31536000, immutable");
		response.headers.set("x-content-type-options", "nosniff");
		return response;
	});
}

function loadDashboardAssetMiddleware(): Promise<
	MiddlewareHandler<PluginEnv<SlackState, SlackConfig>>
> {
	dashboardAssetMiddleware ??= import("@hono/node-server/serve-static").then(({ serveStatic }) =>
		serveStatic<PluginEnv<SlackState, SlackConfig>>({
			rewriteRequestPath: (path) => path,
			root: UI_ASSET_ROOT,
		}),
	);
	return dashboardAssetMiddleware;
}

async function dashboardIndex(
	context: SlackUiContext,
	dependencies: SlackDashboardAssetDependencies,
): Promise<Response> {
	setDocumentHeaders(context);
	let template: string;
	try {
		template = await dependencies.readIndex();
	} catch (cause) {
		if (isMissingFile(cause)) {
			return context.json(
				{
					error: "dashboard_assets_unavailable",
					message: "Slack dashboard assets are not present in this package.",
				},
				503,
			);
		}
		throw cause;
	}
	if (!template.includes(BASE_MARKER)) {
		throw new Error("Slack dashboard index is missing its mount-path base marker.");
	}
	const runtime = context.get("lh");
	const base = `/${encodeURIComponent(runtime.instanceId)}/${encodeURIComponent(runtime.serviceKey)}/`;
	const html = template.replace(BASE_MARKER, `href="${base}" data-localhost2137-base`);
	return context.html(html);
}

function setDocumentHeaders(context: SlackUiContext): void {
	context.header("cache-control", "no-store");
	context.header("content-security-policy", CONTENT_SECURITY_POLICY);
	context.header("referrer-policy", "no-referrer");
	context.header("x-content-type-options", "nosniff");
	context.header("x-frame-options", "DENY");
}

function isMissingFile(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

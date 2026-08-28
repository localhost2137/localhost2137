import { defineConfig } from "localhost2137";
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import { slack } from "../src/index.js";

const dashboardConfig = defineConfig({
	services: {
		"team-chat": slack({
			config: {
				botToken: "xoxb-dashboard-assets",
				eventsUrl: null,
				signingSecret: "dashboard-assets-secret",
				workspaceName: "Asset Test",
			},
		}),
	},
});

type Runtime = TestRuntime<typeof dashboardConfig.services>;
const ownedRuntimes: Runtime[] = [];

afterEach(async () => {
	await Promise.all(ownedRuntimes.splice(0).map((runtime) => runtime.close()));
});

describe("Slack dashboard assets", () => {
	it("serves a mount-aware document with local immutable assets", async () => {
		const runtime = await createTestRuntime({
			config: dashboardConfig,
			port: 0,
			storage: "temporary",
		});
		ownedRuntimes.push(runtime);
		const instance = await runtime.createInstance();
		try {
			const root = new URL("../", instance["team-chat"].connection.apiUrl);
			const withoutTrailingSlash = root.href.slice(0, -1);
			const documentResponse = await fetch(withoutTrailingSlash);
			expect(documentResponse.status).toBe(200);
			expect(documentResponse.headers.get("cache-control")).toBe("no-store");
			expect(documentResponse.headers.get("content-type")).toMatch(/^text\/html\b/);
			expect(documentResponse.headers.get("content-security-policy")).toContain(
				"connect-src 'self'",
			);
			expect(documentResponse.headers.get("content-security-policy")).toContain(
				"script-src 'self'",
			);
			expect(documentResponse.headers.get("x-content-type-options")).toBe("nosniff");
			const document = await documentResponse.text();
			expect(document).toContain(`<base href="${root.pathname}" data-localhost2137-base`);
			expect(document).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);

			const trailingResponse = await fetch(root);
			expect(trailingResponse.status).toBe(200);
			expect(await trailingResponse.text()).toBe(document);

			const scriptReference = requiredMatch(document, /src="([^"]+\.js)"/);
			const styleReference = requiredMatch(document, /href="([^"]+\.css)"/);
			const scriptUrl = new URL(scriptReference, root);
			const styleUrl = new URL(styleReference, root);

			const script = await fetch(scriptUrl);
			expect(script.status).toBe(200);
			expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			expect(script.headers.get("content-type")).toMatch(/javascript/);
			expect(script.headers.get("x-content-type-options")).toBe("nosniff");
			const scriptLength = script.headers.get("content-length");
			expect((await script.text()).length).toBeGreaterThan(10_000);

			const scriptHead = await fetch(scriptUrl, { method: "HEAD" });
			expect(scriptHead.status).toBe(200);
			expect(scriptHead.headers.get("content-length")).toBe(scriptLength);
			expect(await scriptHead.text()).toBe("");

			const style = await fetch(styleUrl);
			expect(style.status).toBe(200);
			expect(style.headers.get("content-type")).toMatch(/^text\/css\b/);
			const css = await style.text();
			const fontReference = requiredMatch(css, /url\(([^)]+\.woff2)\)/);
			const font = await fetch(new URL(fontReference, styleUrl));
			expect(font.status).toBe(200);
			expect(font.headers.get("content-type")).toBe("font/woff2");
			expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

			const head = await fetch(withoutTrailingSlash, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(head.headers.get("content-type")).toMatch(/^text\/html\b/);
			expect(await head.text()).toBe("");
		} finally {
			await instance.destroy();
		}
	});

	it("does not expose files outside the built asset directory", async () => {
		const runtime = await createTestRuntime({
			config: dashboardConfig,
			port: 0,
			storage: "temporary",
		});
		ownedRuntimes.push(runtime);
		const instance = await runtime.createInstance();
		try {
			const root = new URL("../", instance["team-chat"].connection.apiUrl);
			const missing = await fetch(new URL("assets/not-present.js", root));
			expect(missing.status).toBe(404);

			const traversal = await fetch(`${root.href}assets/%252e%252e/index.html`);
			expect(traversal.status).toBe(400);
			expect(await traversal.json()).toEqual({
				error: "invalid_route",
				message: "Invalid instance or service path.",
			});
		} finally {
			await instance.destroy();
		}
	});
});

function requiredMatch(value: string, pattern: RegExp): string {
	const match = pattern.exec(value)?.[1];
	if (!match) throw new TypeError(`Expected ${String(pattern)} in dashboard asset.`);
	return match;
}

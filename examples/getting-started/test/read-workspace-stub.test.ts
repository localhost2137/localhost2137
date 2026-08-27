import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("reads one scripted Slack-shaped response without service state", async () => {
	const requests: Array<Readonly<{ authorization: string | undefined; url: string }>> = [];
	const server = createServer((request, response) => {
		requests.push({
			authorization: request.headers.authorization,
			url: request.url ?? "",
		});
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				members: [{ id: "U_STUB", name: "Scripted Ada" }],
				ok: true,
			}),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});

	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
		const appPath = fileURLToPath(new URL("../src/read-workspace.ts", import.meta.url));
		const { stderr, stdout } = await execFileAsync(process.execPath, [appPath], {
			env: {
				...process.env,
				SLACK_API_URL: `http://127.0.0.1:${address.port}/api/`,
				SLACK_BOT_TOKEN: "xoxb-scripted",
			},
		});

		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual([{ id: "U_STUB", name: "Scripted Ada" }]);
		expect(requests).toEqual([
			{ authorization: "Bearer xoxb-scripted", url: "/api/users.list" },
		]);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve()));
		});
	}
});

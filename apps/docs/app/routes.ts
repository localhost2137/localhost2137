import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { index, type RouteConfig, route } from "@react-router/dev/routes";

const contentRoot = fileURLToPath(new URL("../content/docs", import.meta.url));
const contentPaths = (await listContentPaths(contentRoot)).sort(codeUnitOrder);

export const markdownRoutePaths = contentPaths.map((path) =>
	path === "index.mdx" ? "index.md" : `${path.slice(0, -".mdx".length)}.md`,
);

export default [
	route("api/search", "routes/search.ts"),
	route("llms.txt", "routes/llms-index.ts"),
	route("llms-full.txt", "routes/llms-full.ts"),
	...markdownRoutePaths.map((path) =>
		route(path, "routes/markdown.ts", { id: `markdown/${path}` }),
	),
	index("routes/docs.tsx", { id: "docs-index" }),
	route("*", "routes/docs.tsx", { id: "docs-splat" }),
] satisfies RouteConfig;

async function listContentPaths(directory: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) return listContentPaths(join(directory, entry.name), path);
			return entry.isFile() && entry.name.endsWith(".mdx") ? [path] : [];
		}),
	);
	return nested.flat();
}

function codeUnitOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
	route("api/search", "routes/search.ts"),
	route("llms.txt", "routes/llms-index.ts"),
	route("llms-full.txt", "routes/llms-full.ts"),
	route("index.md", "routes/markdown.ts", { id: "markdown-index" }),
	route(":page.md", "routes/markdown.ts", { id: "markdown-page" }),
	route(":section/:page.md", "routes/markdown.ts", { id: "markdown-nested-page" }),
	route("*", "routes/docs.tsx"),
] satisfies RouteConfig;

import { createRequestHandler } from "react-router";
import {
	getMarkdownPage,
	isMarkdownPath,
	markdownNotFoundResponse,
} from "../lib/markdown-resource";

const handleRequest = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

export default {
	fetch(request: Request): Response | Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (isMarkdownPath(pathname) && !getMarkdownPage(pathname)) {
			return markdownNotFoundResponse();
		}
		return handleRequest(request);
	},
};

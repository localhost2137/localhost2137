import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export function isMarkdownPath(pathname: string): boolean {
	return pathname.endsWith(".md");
}

export function getMarkdownPage(pathname: string) {
	if (!isMarkdownPath(pathname)) return undefined;

	const markdownPath = pathname.slice(1, -".md".length);
	const slugs = markdownPath === "index" ? undefined : markdownPath.split("/");
	return source.getPage(slugs);
}

export async function markdownResponse(pathname: string): Promise<Response> {
	const page = getMarkdownPage(pathname);
	if (!page) return markdownNotFoundResponse();

	return new Response(await getLLMText(page), {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});
}

export function markdownNotFoundResponse(): Response {
	return new Response("Not found", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

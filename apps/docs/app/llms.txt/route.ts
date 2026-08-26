import { source } from "@/lib/source";
import { rewriteLLMIndexLinks } from "@/lib/markdown-routes";
import { llms } from "fumadocs-core/source";

export const revalidate = false;

export function GET(): Response {
	const pageUrls = new Set(source.getPages().map((page) => page.url));
	const index = rewriteLLMIndexLinks(llms(source).index(), pageUrls);
	return new Response(index, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

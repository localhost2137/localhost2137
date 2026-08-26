import { llms } from "fumadocs-core/source";
import { rewriteLLMIndexLinks } from "@/lib/markdown-routes";
import { source } from "@/lib/source";

export function loader(): Response {
	const pageUrls = new Set(source.getPages().map((page) => page.url));
	const index = rewriteLLMIndexLinks(llms(source).index(), pageUrls);
	return new Response(index, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

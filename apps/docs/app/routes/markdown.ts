import type { LoaderFunctionArgs } from "react-router";
import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
	const pathname = new URL(request.url).pathname;
	const markdownPath = pathname.slice(1, -".md".length);
	const slugs = markdownPath === "index" ? undefined : markdownPath.split("/");
	const page = source.getPage(slugs);
	if (!page) return new Response("Not found", { status: 404 });

	return new Response(await getLLMText(page), {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});
}

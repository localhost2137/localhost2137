import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";
import { notFound } from "next/navigation";

export const revalidate = false;

interface MarkdownRouteContext {
	readonly params: Promise<{ readonly slug?: string[] }>;
}

export async function GET(_request: Request, context: MarkdownRouteContext): Promise<Response> {
	const { slug } = await context.params;
	const page = source.getPage(slug?.length === 1 && slug[0] === "index" ? undefined : slug);
	if (!page) notFound();
	return new Response(await getLLMText(page), {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});
}

export function generateStaticParams(): Array<{ slug: string[] }> {
	return source
		.getPages()
		.map((page) => ({ slug: page.slugs.length === 0 ? ["index"] : [...page.slugs] }));
}

import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(): Promise<Response> {
	const content = await Promise.all(source.getPages().map(getLLMText));
	return new Response(content.join("\n\n"), {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

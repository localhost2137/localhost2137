import { getLLMText } from "@/lib/get-llm-text";
import { getSidebarPages } from "@/lib/source";

export async function loader(): Promise<Response> {
	const content = await Promise.all(getSidebarPages().map(getLLMText));
	return new Response(content.join("\n\n"), {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

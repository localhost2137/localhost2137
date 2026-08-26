import type { LoaderFunctionArgs } from "react-router";
import { markdownResponse } from "@/lib/markdown-resource";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
	return markdownResponse(new URL(request.url).pathname);
}

import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";
import type { Route } from "./+types/search";

const search = createFromSource(source, { language: "english" });

export function loader({ request }: Route.LoaderArgs) {
	return search.GET(request);
}

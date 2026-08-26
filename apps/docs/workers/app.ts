import { createRequestHandler } from "react-router";

const handleRequest = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

export default {
	fetch(request: Request): Promise<Response> {
		return handleRequest(request);
	},
};

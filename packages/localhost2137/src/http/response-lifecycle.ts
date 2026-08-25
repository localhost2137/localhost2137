export function responseWithFinalizer(response: Response, finalize: () => void): Response {
	if (!response.body) {
		finalize();
		return response;
	}
	const reader = response.body.getReader();
	let finalized = false;
	const finish = () => {
		if (finalized) return;
		finalized = true;
		finalize();
	};
	const body = new ReadableStream<Uint8Array>({
		cancel: async (reason) => {
			try {
				await reader.cancel(reason);
			} finally {
				finish();
			}
		},
		pull: async (controller) => {
			try {
				const chunk = await reader.read();
				if (chunk.done) {
					finish();
					controller.close();
					return;
				}
				controller.enqueue(chunk.value);
			} catch (cause) {
				finish();
				controller.error(cause);
			}
		},
	});
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_INTERVAL_MS = 2_000;

export interface SlackWorkspacePollerOptions<Value> {
	readonly isVisible: () => boolean;
	readonly load: (signal: AbortSignal) => Promise<Value>;
	readonly onError: (cause: unknown) => void;
	readonly onValue: (value: Value) => void;
	readonly pollIntervalMs?: number;
	readonly retryIntervalMs?: number;
	readonly schedule?: (work: () => void, delayMs: number) => () => void;
}

export interface SlackWorkspacePoller {
	refresh(): void;
	start(): void;
	stop(): void;
	visibilityChanged(): void;
}

export function createSlackWorkspacePoller<Value>(
	options: SlackWorkspacePollerOptions<Value>,
): SlackWorkspacePoller {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
	const schedule = options.schedule ?? browserSchedule;
	let active: Readonly<{ controller: AbortController; promise: Promise<void> }> | null = null;
	let cancelScheduled: (() => void) | null = null;
	let pendingRefresh = false;
	let running = false;
	let retry = false;

	const cancelTimer = () => {
		cancelScheduled?.();
		cancelScheduled = null;
	};

	const scheduleNext = () => {
		cancelTimer();
		if (!running || !options.isVisible()) return;
		cancelScheduled = schedule(
			() => {
				cancelScheduled = null;
				void run();
			},
			retry ? retryIntervalMs : pollIntervalMs,
		);
	};

	const run = (): Promise<void> => {
		if (!running || !options.isVisible()) return Promise.resolve();
		if (active) {
			pendingRefresh = true;
			return active.promise;
		}
		cancelTimer();
		pendingRefresh = false;
		const controller = new AbortController();
		const promise = options
			.load(controller.signal)
			.then((value) => {
				if (controller.signal.aborted || !running) return;
				retry = false;
				options.onValue(value);
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return;
				retry = true;
				options.onError(cause);
			})
			.finally(() => {
				active = null;
				if (pendingRefresh && running && options.isVisible()) {
					void run();
					return;
				}
				scheduleNext();
			});
		active = { controller, promise };
		return promise;
	};

	return Object.freeze({
		refresh() {
			pendingRefresh = true;
			void run();
		},
		start() {
			if (running) return;
			running = true;
			void run();
		},
		stop() {
			if (!running) return;
			running = false;
			pendingRefresh = false;
			cancelTimer();
			active?.controller.abort("Slack dashboard polling stopped.");
		},
		visibilityChanged() {
			if (!running) return;
			if (!options.isVisible()) {
				cancelTimer();
				active?.controller.abort("Slack dashboard is hidden.");
				return;
			}
			pendingRefresh = true;
			void run();
		},
	});
}

function browserSchedule(work: () => void, delayMs: number): () => void {
	const timer = globalThis.setTimeout(work, delayMs);
	return () => globalThis.clearTimeout(timer);
}

import type { DueDeliveryAttempt, SlackRetryReason } from "../persistence/delivery-repository.js";

const MAX_DELIVERY_ATTEMPTS = 4;

// Slack documents three retries: nearly immediately, then after one minute,
// then after five minutes. The immediate retry is durably due at the failure
// instant and runs on the next time-advance reconciliation.
const RETRY_DELAY_MS_BY_COMPLETED_ATTEMPT = Object.freeze({
	1: 0,
	2: 60_000,
	3: 5 * 60_000,
} as const);

export type DeliveryError =
	| "non_success_status"
	| "response_body_error"
	| "timeout"
	| "transport_error";

export function nextRetryDeadline(attempt: DueDeliveryAttempt): Date | undefined {
	if (attempt.attempt >= MAX_DELIVERY_ATTEMPTS) return undefined;
	const delay =
		RETRY_DELAY_MS_BY_COMPLETED_ATTEMPT[
			attempt.attempt as keyof typeof RETRY_DELAY_MS_BY_COMPLETED_ATTEMPT
		];
	if (delay === undefined) return undefined;
	return new Date(attempt.scheduledAt.getTime() + delay);
}

export function retryReasonFor(error: DeliveryError): SlackRetryReason {
	if (error === "timeout") return "http_timeout";
	if (error === "non_success_status") return "http_error";
	if (error === "transport_error") return "connection_failed";
	return "unknown_error";
}

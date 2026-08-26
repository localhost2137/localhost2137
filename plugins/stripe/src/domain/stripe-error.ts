export type StripeErrorCode =
	| "advance_conflict"
	| "customer_missing"
	| "invalid_argument"
	| "price_missing"
	| "product_missing"
	| "subscription_canceled"
	| "subscription_missing";

export class StripeError extends Error {
	readonly code: StripeErrorCode;
	readonly parameter: string | undefined;

	constructor(code: StripeErrorCode, message: string, parameter?: string) {
		super(message);
		this.name = "StripeError";
		this.code = code;
		this.parameter = parameter;
	}
}

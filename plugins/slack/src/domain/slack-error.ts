export type SlackErrorCode =
	| "channel_not_found"
	| "invalid_arguments"
	| "invalid_auth"
	| "name_taken"
	| "not_in_channel"
	| "user_not_found";

export class SlackError extends Error {
	readonly code: SlackErrorCode;

	constructor(code: SlackErrorCode, message: string) {
		super(message);
		this.name = "SlackError";
		this.code = code;
	}
}

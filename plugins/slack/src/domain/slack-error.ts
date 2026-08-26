export type SlackErrorCode =
	| "channel_not_found"
	| "invalid_arguments"
	| "invalid_auth"
	| "invalid_cursor"
	| "invalid_limit"
	| "invalid_ts_latest"
	| "invalid_ts_oldest"
	| "invalid_types"
	| "missing_argument"
	| "name_taken"
	| "no_text"
	| "not_authed"
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

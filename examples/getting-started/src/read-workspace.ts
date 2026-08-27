type UsersListResponse =
	| { members: Array<{ id: string; name: string }>; ok: true }
	| { error: string; ok: false };

const apiUrl = requiredEnvironment("SLACK_API_URL");
const botToken = requiredEnvironment("SLACK_BOT_TOKEN");
const response = await fetch(new URL("users.list", apiUrl), {
	headers: { authorization: `Bearer ${botToken}` },
});
const payload = (await response.json()) as UsersListResponse;

if (!response.ok || !payload.ok) {
	throw new Error(
		`Local Slack request failed: ${"error" in payload ? payload.error : response.status}`,
	);
}

console.log(JSON.stringify(payload.members.map(({ id, name }) => ({ id, name }))));

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}. Run this command through localhost run.`);
	return value;
}

const stream = new URL(import.meta.url).searchParams.get("stream");
const output = "authoring-secret-must-not-escape\n".repeat(100_000);

if (stream === "stderr") process.stderr.write(output);
else process.stdout.write(output);

setInterval(() => undefined, 60_000);

export const noisyConfig = { services: { fixture: {} } };

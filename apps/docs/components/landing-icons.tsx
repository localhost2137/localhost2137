export function Icon({
	name,
	className,
}: Readonly<{
	name:
		| "check"
		| "copy"
		| "external"
		| "send"
		| "code"
		| "local"
		| "browser"
		| "github"
		| "arrow-right"
		| "arrow-up-right"
		| "close"
		| "sun"
		| "moon";
	className?: string;
}>) {
	if (name === "github") {
		return (
			<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
			</svg>
		);
	}
	const paths = {
		check: "m4 10 4 4 8-8",
		copy: "M7 7h9v10H7zM13 7V3H3v10h4",
		external: "M7 4H4v12h12v-3M10 3h7v7M8 12l9-9",
		send: "m3 3 15 7-15 7 3-7-3-7Zm3 7h12",
		code: "m6 5-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
		local: "M4 3h12v10H4zM2 17h16m-10-4-1 4m5-4 1 4",
		browser: "M3 3h14v14H3zM3 7h14M6 5h.01M9 5h.01",
		"arrow-right": "M3 10h14m-6-6 6 6-6 6",
		"arrow-up-right": "M5 15 15 5M5 5h10v10",
		close: "m5 5 10 10M5 15 15 5",
		sun: "M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM10 1v2m0 14v2M1 10h2m14 0h2M3.6 3.6 5 5m10 10 1.4 1.4M3.6 16.4 5 15M15 5l1.4-1.4",
		moon: "M17.5 11.2A7.6 7.6 0 0 1 8.8 2.5a7.6 7.6 0 1 0 8.7 8.7Z",
	};
	return (
		<svg
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<path d={paths[name]} />
		</svg>
	);
}

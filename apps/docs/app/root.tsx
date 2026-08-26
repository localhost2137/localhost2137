import { RootProvider } from "fumadocs-ui/provider/react-router";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./global.css";
import NotFound from "./routes/not-found";

const siteDescription = "Documentation for the localhost2137 service-emulator runtime.";

export function meta({ error }: Route.MetaArgs): Route.MetaDescriptors {
	if (isRouteErrorResponse(error) && error.status === 404) {
		return [{ title: "Not found — localhost2137" }];
	}

	return [
		{ title: "localhost2137 documentation" },
		{ name: "description", content: siteDescription },
	];
}

export function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<Meta />
				<Links />
			</head>
			<body>
				<RootProvider>{children}</RootProvider>
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	if (isRouteErrorResponse(error) && error.status === 404) {
		return <NotFound />;
	}

	const message = error instanceof Error ? error.message : "The documentation request failed.";
	return (
		<main className="lh-error">
			<p className="lh-error-code">500</p>
			<h1>Documentation unavailable</h1>
			<p>{message}</p>
		</main>
	);
}

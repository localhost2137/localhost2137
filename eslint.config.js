import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const runtimeInternals = [
	"**/config/**",
	"**/kernel/**",
	"**/node/**",
	"**/http/**",
	"**/control/**",
	"**/cli/**",
	"**/testing/**",
];

const sideEffectGlobals = [
	"console",
	"crypto",
	"fetch",
	"globalThis",
	"process",
	"queueMicrotask",
	"setInterval",
	"setTimeout",
	"WebSocket",
	"Worker",
].map((name) => ({
	message: "Public authoring modules must receive side-effecting capabilities explicitly.",
	name,
}));

export default defineConfig([
	{
		ignores: [
			"**/.react-router/**",
			"**/.wrangler/**",
			"**/build/**",
			"**/dist/**",
			"**/coverage/**",
			"**/node_modules/**",
			"design/**",
		],
	},
	{
		files: [
			"apps/**/*.ts",
			"apps/**/*.tsx",
			"packages/**/*.ts",
			"plugins/**/*.ts",
			"examples/**/*.ts",
		],
		languageOptions: {
			parser: tseslint.parser,
		},
	},
	{
		files: ["packages/localhost2137/src/index.ts", "packages/localhost2137/src/authoring/**/*.ts"],
		rules: {
			"no-restricted-globals": ["error", ...sideEffectGlobals],
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						...runtimeInternals.map((group) => ({
							group: [group],
							message: "Authoring contracts must not depend on runtime or adapter modules.",
						})),
						{
							group: ["node:*"],
							message: "Public authoring modules cannot import Node.js capabilities.",
						},
					],
				},
			],
		},
	},
	{
		files: ["plugins/**/*.ts"],
		ignores: ["plugins/*/test/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["localhost2137/*", "**/packages/localhost2137/src/**"],
							message: "Plugins may import only the public localhost2137 package root.",
						},
					],
				},
			],
		},
	},
	{
		files: ["plugins/*/test/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: [
								"localhost2137/*",
								"!localhost2137/testing",
								"!localhost2137/client",
								"**/packages/localhost2137/src/**",
							],
							message: "Plugin tests may use only public localhost2137 package exports.",
						},
					],
				},
			],
		},
	},
	{
		files: ["packages/plugin-testkit/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							message: "The test kit must consume public package exports, never src internals.",
							regex: "(^|/)localhost2137/src(/|$)",
						},
						{
							message: "The test kit may import only localhost2137, /testing, or /client.",
							regex: "^localhost2137/(?!(testing|client)$).*$",
						},
					],
				},
			],
		},
	},
]);

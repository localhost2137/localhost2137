import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const runtimeInternals = [
	"**/config/**",
	"**/kernel/**",
	"**/node/**",
	"**/control/**",
	"**/cli/**",
	"**/testing/**",
];

export default defineConfig([
	{
		ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "design/**"],
	},
	{
		files: ["packages/**/*.ts", "plugins/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
		},
	},
	{
		files: ["packages/localhost2137/src/authoring/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: runtimeInternals.map((group) => ({
						group: [group],
						message: "Authoring contracts must not depend on runtime or adapter modules.",
					})),
				},
			],
		},
	},
	{
		files: ["plugins/**/*.ts", "packages/plugin-testkit/**/*.ts"],
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
]);

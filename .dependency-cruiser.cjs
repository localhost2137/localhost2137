/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular-modules",
			severity: "error",
			from: {},
			to: { circular: true },
		},
		{
			name: "public-root-exports-authoring-only",
			severity: "error",
			from: { path: "^packages/localhost2137/src/index\\.ts$" },
			to: { path: "^packages/localhost2137/src/(?!authoring(?:/|$))" },
		},
		{
			name: "authoring-does-not-depend-on-runtime",
			severity: "error",
			from: { path: "^packages/localhost2137/src/authoring" },
			to: { path: "^packages/localhost2137/src/(config|kernel|node|http|control|cli|testing)" },
		},
		{
			name: "kernel-does-not-depend-on-adapters",
			severity: "error",
			from: { path: "^packages/localhost2137/src/kernel" },
			to: { path: "^packages/localhost2137/src/(config|node|http|control|cli|testing)" },
		},
		{
			name: "plugins-use-public-root-only",
			severity: "error",
			from: { path: "^plugins/" },
			to: { path: "^packages/localhost2137/src/(?!index\\.ts$)" },
		},
		{
			name: "plugin-testkit-does-not-import-runtime-source",
			severity: "error",
			from: { path: "^packages/plugin-testkit/" },
			to: { path: "^packages/localhost2137/src/" },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: "(^|/)(dist|coverage|node_modules)/",
		includeOnly: "^(packages|plugins)/",
		progress: { type: "none" },
		tsConfig: { fileName: "tsconfig.base.json" },
	},
};

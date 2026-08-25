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
			name: "authoring-does-not-depend-on-runtime",
			severity: "error",
			from: { path: "^packages/localhost2137/src/authoring" },
			to: { path: "^packages/localhost2137/src/(config|kernel|node|control|cli|testing)" },
		},
		{
			name: "kernel-does-not-depend-on-adapters",
			severity: "error",
			from: { path: "^packages/localhost2137/src/kernel" },
			to: { path: "^packages/localhost2137/src/(config|node|control|cli|testing)" },
		},
		{
			name: "plugins-do-not-import-runtime-internals",
			severity: "error",
			from: { path: "^(plugins|packages/plugin-testkit)/" },
			to: { path: "^packages/localhost2137/src/(config|kernel|node|control|cli|testing)" },
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

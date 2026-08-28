import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const uiRoot = fileURLToPath(new URL("./", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../assets/ui/", import.meta.url));

export default defineConfig({
	base: "./",
	build: {
		assetsInlineLimit: 0,
		emptyOutDir: true,
		outDir: outputDirectory,
		sourcemap: false,
	},
	plugins: [tailwindcss()],
	root: uiRoot,
});

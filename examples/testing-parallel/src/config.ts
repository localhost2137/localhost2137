import { defineConfig } from "localhost2137";
import { counterPlugin } from "./counter-plugin.js";

export const config = defineConfig({
	services: { counter: counterPlugin({ config: {} }) },
});

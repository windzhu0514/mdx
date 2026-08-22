import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [vue()],
    clearScreen: false,
    build: {
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        {
                            name: "editor-prosemirror",
                            test: /node_modules[\\/]prosemirror-/,
                            priority: 10,
                        },
                    ],
                },
            },
        },
    },
    server: {
        port: 1420,
        strictPort: true,
        host: "127.0.0.1",
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
    test: {
        exclude: [...configDefaults.exclude, "scripts/**/*.test.mjs"],
    },
});

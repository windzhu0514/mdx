import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "src-tauri/target/**",
            "src-tauri/target-*/**",
            "src-tauri/gen/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...vue.configs["flat/recommended"],
    {
        files: ["**/*.{js,mjs}"],
        languageOptions: { globals: globals.node },
    },
    {
        files: ["**/*.{ts,vue}"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                parser: tseslint.parser,
                extraFileExtensions: [".vue"],
                sourceType: "module",
            },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "vue/multi-word-component-names": "off",
            "vue/no-v-html": "error",
            "vue/html-indent": "off",
            "vue/max-attributes-per-line": "off",
            "vue/singleline-html-element-content-newline": "off",
            "vue/html-self-closing": "off",
        },
    },
);

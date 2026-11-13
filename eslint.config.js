import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noDynamicSql from "./eslint-rules/no-dynamic-sql.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
      "frontend/**",
      "eslint-rules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { bma: { rules: { "no-dynamic-sql": noDynamicSql } } },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "bma/no-dynamic-sql": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts", "**/scripts/**/*.ts"],
    rules: { "no-console": "off", "bma/no-dynamic-sql": "off" },
  },
);

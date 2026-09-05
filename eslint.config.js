import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", ".wrangler", "worker-configuration.d.ts", "migrations", "dev-dist"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/client/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["src/server/**/*.ts", "src/shared/**/*.ts", "test/**/*.ts"],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.node } },
  },
  {
    files: ["*.config.{js,ts}", "auth.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The toolkit's vanilla ES5 modules and their Node test suite: browser +
    // CommonJS globals, script (not module) parsing, and the idioms they were
    // written in. They are covered by tests/run-tests.js rather than by lint.
    files: ["src/shared/atv/**/*.js", "src/client/features/atv/js/**/*.js", "tests/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-prototype-builtins": "off",
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
);

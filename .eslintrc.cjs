module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    browser: true,
    worker: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  ignorePatterns: [
    "dist",
    ".wrangler",
    "node_modules",
    "coverage",
    /** Dashboard multi-surface prod builds (see scripts/dashboard_build_prod_surfaces.mjs) */
    "apps/dashboard/dist-app/**",
    "apps/dashboard/dist-console/**",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
  },
};

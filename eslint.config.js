import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "widgets/**",
      "snapshots/**",
      "admin-panel.html",
      "admin-panel.html.backup",
      // Auth0 Post Login Actions (#702): CommonJS run by Auth0's runtime, pasted
      // into each tenant as written; scripts/check-auth0-tenant.ts compares them.
      "docs/auth0/actions/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // On for src (#686); the tests block below keeps it off. A leading _ marks an
      // argument kept for its position, and a rest sibling drops a key on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true, caughtErrors: "none" }
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-console": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off"
    }
  },
  {
    // CI helper scripts are plain Node ESM, not TypeScript, so the "**/*.ts"
    // block above does not reach them and they would fail no-undef on
    // `process` and `console`.
    files: [".github/scripts/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-console": "off"
    }
  }
);

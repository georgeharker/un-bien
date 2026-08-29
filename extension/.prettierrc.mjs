/**
 * Formatting config for the un-bien fork extension (TypeScript).
 * pi-lens formats JS/TS via its formatter cascade ["biome", "prettier", ...];
 * biome's tab default was mangling this 2-space codebase, so this file pins
 * prettier(d) as the formatter. These are prettier's DEFAULTS made explicit —
 * double-quote + semicolons (NOT pi-acp's single-quote/no-semi) to match the
 * existing un-bien style. The win is consistency; flip options later if wanted.
 *
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 */
const config = {
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  trailingComma: "all",
  printWidth: 80,
};

export default config;

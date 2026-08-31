/**
 * Formatting config for the un-bien MONOREPO (extension, launcher, root).
 * pi-lens formats JS/TS via its formatter cascade ["biome", "prettier", ...];
 * biome's tab default was mangling this 2-space codebase, so this file pins
 * prettier(d) as the formatter. Style (user 2026-08-31): double quotes,
 * SEMICOLON-FREE (matches the app side's Swift feel; pi-acp's no-semi was
 * right on that one). The one-shot reformat lives in an isolated,
 * blame-ignored commit — see .git-blame-ignore-revs.
 *
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 */
const config = {
  semi: false,
  singleQuote: false,
  tabWidth: 2,
  useTabs: false,
  trailingComma: "all",
  printWidth: 80,
}

export default config

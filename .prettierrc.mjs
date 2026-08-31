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
  // Harden against the formatter CASCADE: prettier also claims YAML/JSON/
  // Markdown when pi-lens formats them. This repo's YAML is already
  // 2-space (tabWidth matches), but printWidth 80 would wrap the workflow
  // lines longer than 80 cols on the next format pass. proseWrap stays
  // default (preserve) so Markdown prose is not reflowed.
  overrides: [
    {
      files: ["*.yml", "*.yaml", "*.json", "*.jsonc", "*.md", "*.mdx"],
      options: { tabWidth: 2, printWidth: 120 },
    },
  ],
}

export default config

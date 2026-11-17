# @clowdy/styles

Product CSS for Clowdy: the page shell and the design tokens.

`src/index.css` sets the layer order and imports reset, fonts, base, utilities, and the token sheet. CSS modules take mixins from `@clowdy/styles/rulesets`. The token sheet alone is `@clowdy/styles/tokens`. `uno.config.ts` maps the tokens to UnoCSS utilities (`@clowdy/styles/uno`), and `layer-order.ts` pins the CSS layer order in Vite builds.

## Token files

```
src/tokens/
├── variables/         # Primitive, motion, and semantic variables
├── styles/            # Typography / shadows / colors utilities
├── local/             # zIndex, breakpoints, misc (squircle knobs), playground (scratch pad)
├── rulesets.css       # Ruleset entry point (`@ruleset` mixins, expanded by PostCSS)
└── index.css          # Token entry point
```

The tokens were brought over from Reforma's design system, where they were generated from Figma. This repository has no Figma sync, so the files are edited by hand. Keep the structure: semantic variables in `variables/theme.css` (`.dark` overrides the dark theme), typography rulesets in `rulesets.css`.

Component-, model-, or feature-specific semantic variables belong in the owning CSS module next to their consumers, mapped to these tokens.

## PostCSS

`@ruleset` and `@reference` come from the root `postcss.config.mjs`. A CSS module that uses `@ruleset` starts with `@reference '@clowdy/styles/rulesets';`.

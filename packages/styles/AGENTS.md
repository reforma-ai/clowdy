# @clowdy/styles

Product CSS. `src/index.css` is the page shell (layer order, reset, fonts, base, utilities). Design tokens live under `src/tokens/` and are also exported as `@clowdy/styles/tokens` and `@clowdy/styles/rulesets`.

## Token ownership

- The tokens came from Reforma's Figma-synced set, but this repo has no Figma sync: `src/tokens/variables/` and `src/tokens/styles/` are edited by hand.
- Do not add patch, override, fallback, or temporary token files. Add a missing shared token to the owning file under `variables/` or `styles/`.
- Component-, model-, or feature-specific semantic variables belong in the owning CSS module next to their consumers. Map them to tokens there, following the component styles in `@clowdy/components`; do not promote them into this package for convenience.
- `src/tokens/local/zIndex.css`, `breakpoints.css`, and `misc.css` (squircle engine knobs: `--squircle-value`, `--squircle-radius-factor`) hold the values that never came from Figma. `local/playground.css` is a scratch pad that wins over everything in `@layer tokens`: keep it empty.
- `src/tokens/index.css` and `src/tokens/rulesets.css` are entry points, not places for token values.

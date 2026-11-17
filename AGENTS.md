# Clowdy monorepo

Follow @BRIEFBACK.md for delivery and @GITFLOW.md for Git. Comments, plans, research, commits, docs, identifiers, and test titles are English only
Chat may match the user.

Product spec: `spec.md`. Visual language: `DESIGN.md`.

## Layout

| Path | What |
| --- | --- |
| `apps/desktop` | Electron app: main, preload, and the React + Vite renderer. The only target (macOS, Windows). Read its `AGENTS.md` first. |
| `packages/components` | Design system components (React Aria based). Read its `AGENTS.md` before writing UI. |
| `packages/styles` | Design tokens, reset, fonts, UnoCSS config. |
| `packages/icons` | Icon packs, generated into `dist/` by `bun run build`. |
| `packages/lib`, `packages/constants` | Shared helpers and constants, consumed as source. |
| `packages/config-typescript`, `packages/eslint-config` | Shared tsconfig and ESLint presets. |

`apps/daemon`, `packages/protocol`, and the rest of the spec's structure appear when their stage starts.

## Tooling

- **Bun only**, never npm/pnpm. Node >=22.12. TypeScript 7 (`typescript` package). Build orchestration: Turborepo.
- `./clowdy dev` runs the app with hot reload; `./clowdy build [mac|win]` builds the unpacked app into `apps/desktop/release/`. Where `./clowdy` cannot run (Windows), use `bun run clowdy <command>`.
- Tests: `bun run test` (Vitest), never bare `bun test`. Lint: `bun run lint`; fix with `bun run lint:fix` in a package. Types: `bun run typecheck`. Both also check the root `scripts/`.
- Root `bunfig.toml` blocks resolving versions under 3 days old (`minimumReleaseAge`). For an urgent fix use `bun add <pkg>@<version> --minimum-release-age 0` and say so in the PR.
- Electron 45 downloads its binary on first use (`./clowdy dev` imports it), not at install time.
- Design system, icons, and components were forked from Reforma. There is no Figma sync here: edit tokens and icons by hand (see `packages/styles/AGENTS.md`).

# Clowdy monorepo

Follow @BRIEFBACK.md for delivery and @GITFLOW.md for Git. Comments, plans, research, commits, docs, identifiers, and test titles are English only
Chat may match the user.

Product spec: `spec.md`. Visual language: `DESIGN.md`. License: Apache-2.0 (`LICENSE`, `NOTICE`); the name and the logo are not licensed (`TRADEMARKS.md`), and the code adapted from Reforma is the project's own under the same license, as `NOTICE` says. A new package gets `"license": "Apache-2.0"`.

UI text that is a phrase or a single sentence ends without a period: a label, description, hint, placeholder, note, empty state, toast, or error (`Not signed in`, `Sign in to see your limits`, `Couldn't read the usage`). A period dangling after one sentence looks broken in the interface. Keep periods only in text of two sentences or more. This covers the daemon's messages that the app shows (`detail`, setting descriptions, sign-in messages).

## Layout

| Path | What |
| --- | --- |
| `apps/desktop` | Electron app: main, preload, and the React + Vite renderer. The only target (macOS, Windows). Read its `AGENTS.md` first. |
| `packages/components` | Design system components (React Aria based). Read its `AGENTS.md` before writing UI. |
| `packages/styles` | Design tokens, reset, fonts, UnoCSS config. |
| `packages/file-manager` | File tree and text editor over any file system provider (forked from Reforma): the side panel's Files tab. Read its `AGENTS.md`. |
| `packages/icons` | Icon packs, generated into `dist/` by `bun run build`. |
| `packages/lib`, `packages/constants` | Shared helpers and constants, consumed as source. |
| `packages/config-typescript`, `packages/eslint-config` | Shared tsconfig and ESLint presets. |

`apps/daemon`, `packages/protocol`, and the rest of the spec's structure appear when their stage starts.

## Tooling

- **Bun only**, never npm/pnpm. Node >=22.12. TypeScript 7 (`typescript` package). Build orchestration: Turborepo.
- `./clowdy dev` runs the app, rebuilding the renderer and reloading the window as you edit; `./clowdy build [mac|win]` builds the unpacked app into `apps/desktop/release/`; `./clowdy sync icons` pulls the icons from Figma. Where `./clowdy` cannot run (Windows), use `bun run clowdy <command>`.
- `./clowdy licenses` regenerates `THIRD-PARTY-LICENSES.md` (the credits file the About page links to) from the production dependencies of `apps/desktop` and `apps/daemon` plus the hand-written entries in `scripts/licenses-extra.md`. Run it and commit the file when those dependencies change.
- Tests: `bun run test` (Vitest), never bare `bun test`; the exception is `apps/daemon`, whose tests run with `bun test` because they need Bun's runtime (`bun:sqlite`). Lint: `bun run lint`; fix with `bun run lint:fix` in a package. Types: `bun run typecheck`. Both also check the root `scripts/`.
- Root `bunfig.toml` blocks resolving versions under 3 days old (`minimumReleaseAge`). For an urgent fix use `bun add <pkg>@<version> --minimum-release-age 0` and say so in the PR.
- Electron 45 downloads its binary on first use (`./clowdy dev` imports it), not at install time.
- Design system, icons, and components were forked from Reforma. Icons come from Reforma's Figma file: draw them there and run `./clowdy sync icons` (see `packages/icons/README.md`; the token is shared with Reforma's `./reforma sync icons auth`). There is no Figma sync for tokens: edit them by hand (see `packages/styles/AGENTS.md`).

# Move Clowdy from ESLint to Biome

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** Lint and format Clowdy with Biome, as Reforma does since 2026-11-17 (`chore: replace eslint with biome`), and remove ESLint and `packages/eslint-config`.
**Approach:** The work happens in the worktree `../clowdy-biome` (branch `maksim-kachurin/biome`, started from `next`), so it never blocks the agents working on `next`. Stage 1 ports Reforma's `biome.json` and switches the scripts, Stage 2 is the one mechanical reformat of the whole repository plus the lint fixes, Stage 3 removes ESLint. Stage 4 is the merge back, done only when the owner says so and the main tree is clean; the reformat is re-run after `origin/next` is merged in, so nothing the other agents wrote in the meantime is lost or left in the old style.

**Decisions**

- Clowdy takes Reforma's tooling and style as they are: Biome 2.6.6 (Reforma's version), `biome.json` ported from `/Users/bionic/WORK/Reforma/reforma/biome.json` (formatter: 4 spaces, 120 columns, single quotes, double JSX quotes, semicolons, trailing commas `es5`, arrow parentheses `asNeeded`; linter: the same preset with the same rules switched off; `organizeImports` with Reforma's groups).
- That changes how Clowdy's code looks, and the owner accepts it: no spaces inside JSX braces (`className={styles.x}`, not `{ styles.x }`), lines wrapped at 120 columns, imports ordered by Biome and not by perfectionist. The reason is that Clowdy ports code from Reforma and wants to read and diff it in one style.
- What ESLint checked and Biome does not (the `react-hooks` compiler rules, `react-refresh`, perfectionist's ordering of exports and JSX props) is given up, as Reforma gave it up; `tsc` stays the check for unused code. Reforma's `file-manager` import and global restrictions are ported with `@clowdy/*` names, because Clowdy's `packages/file-manager/eslint.config.mjs` holds the same boundary: read it and keep it.
- The repository is reformatted in one mechanical commit, whose hash goes to `.git-blame-ignore-revs` in the next commit, so `git blame` skips it.
- ESLint, `packages/eslint-config` (a copy of Reforma's, MIT, Copyright (c) 2026 Reforma, Inc.), its dependencies and the 15 `eslint-disable` directives are removed. `NOTICE`, `scripts/licenses-extra.md` and `THIRD-PARTY-LICENSES.md` lose their eslint-config entries.
- The work lives on the branch `maksim-kachurin/biome` in `../clowdy-biome` and is pushed there. It is merged into `next` only when the owner says so, from the main checkout with a clean tree, as a merge commit (GITFLOW.md, Worktrees).

**Reuse:** Reforma's `biome.json` and its per-package `"lint": "biome check"` scripts; `scripts/cli.ts` and `./clowdy licenses` (regenerates the credits file).

## Out of scope

- Reforma's repository (its leftover empty `packages/eslint-config` folder is not touched).
- Changing any behavior of the app; this is formatting, linting and tooling only.
- Adding Husky or lint-staged.

## Stage 1 — Biome config and scripts

**Depends on:** None.

**This stage:** Adds Biome 2.6.6 and a `biome.json` ported from Reforma's, adapted to Clowdy's folders (no `apps/api` plugins, the file-manager boundary with `@clowdy/*` names, ignores for generated and vendored files such as `dist`, `release`, `app`, `bundle`, `runtime`, icon assets, fixtures, `THIRD-PARTY-LICENSES.md`), and switches every package's `lint` and `lint:fix` script to Biome. Nothing is reformatted yet, so the stage ends with `biome check` running and reporting formatting and import-order differences plus a short list of real lint findings.

- [x] Complete
  - [x] `@biomejs/biome` 2.6.6 is a root dev dependency and `bun install --frozen-lockfile` is clean
  - [x] `biome.json` exists, loads without errors and ignores what is generated or vendored
  - [x] The file-manager import and global restrictions of the old ESLint config are in `biome.json` as overrides
  - [x] Every package's `lint` is `biome check` and `lint:fix` is `biome check --write`; the root `lint` runs turbo and `biome check scripts`

**Files**

- `package.json`, `bun.lock` — the dev dependency and the root `lint`
- `biome.json` — create: cannot join any existing file, Clowdy has no Biome config yet
- `apps/desktop/package.json`, `apps/daemon/package.json`, `packages/*/package.json` — the `lint` and `lint:fix` scripts
- `packages/file-manager/eslint.config.mjs` — read only, for the boundary rules to port

**Done when:** `bunx biome check` runs over the whole repository and finishes with diagnostics, not with a configuration error.
**Verify:** `bun install --frozen-lockfile`, `bunx biome check 2>&1 | tail`, `bun run lint` runs through turbo.
**Scope notes (recorded while building):**

- Clowdy's `packages/file-manager/eslint.config.mjs` was only `export default await config`: it never held the boundary (the fork dropped the overrides that Reforma's file has). Biome's overrides are Reforma's, ported with `@clowdy/*` names, so the boundary is now enforced for the first time; the existing code has no violation of it (checked: `biome lint` on `packages/file-manager` reports only the old `eslint.config.mjs` importing `@clowdy/eslint-config`, which Stage 3 deletes). A throwaway file caught every rule (a forbidden `@clowdy/protocol` import anywhere in the package; `react`, `@codemirror/view`, `@clowdy/components` and `./react/*` imports and `window`/`document` in the core; none of those flagged under `src/react`).
- `lint` and `lint:fix` also go to `packages/constants`, `packages/icons` and `packages/config-typescript`, which had no `lint` script, so `turbo run lint` covers every package. The root `lint` is `turbo run lint && bun run lint:root`, and `lint:root` runs Biome on `scripts`, `.github`, and the root config files (the old root ESLint covered `scripts` and `postcss.config.mjs`).
- `turbo.json`: `lint` no longer waits for `^build` (Biome reads sources only) and hashes `biome.json`, as Reforma's does. `gate.yml` calls `bun run lint:root` instead of `bunx eslint scripts`, and `ci.yml` watches `biome.json` instead of `eslint.config.mjs`.
- `biome.json` ignores, besides Reforma's `dist`: `node_modules`, `.turbo`, the desktop's `app`, `bundle`, `runtime`, `release`, `.ota-local`, `.briefback`, `.claude`, `.codegraph` (fully, so they are not even indexed) and every SVG; the formatter also skips `fixtures`, `*.generated.*`, Markdown, `THIRD-PARTY-LICENSES.md`, the Lottie `reforma-loader.json` and the icon sync's own `figma-icons-manifest.json` (the sync script writes it with `JSON.stringify`, so formatting it would only be undone by the next sync). Reforma's `apps/api` plugins and its `apps/api`/`sandbox`/`storybook` paths are gone.
- Baseline on `next` before the reformat, in this worktree (`bun run typecheck`, `bun run test`): typecheck fails only in `apps/daemon` with 7 errors in 6 files (`ReadableStream`/`BodyInit`, TS2352 and TS2345); all other packages and `tsc -p scripts` pass. Tests: protocol 71, lib 75, icons 23, daemon 2244 pass / 0 fail (2252 tests, 83 files), components 257, file-manager 171, desktop 4508 in 245 files with the known unhandled `AbortError` (which makes the desktop's `test` exit 1), system-skills `validate` passes. The first Biome run reported 1180 files to format, 410 import orders and 36 lint findings plus the old ESLint config tripping the boundary (22 `noControlCharactersInRegex`, 4 `noCommaOperator`, 4 `noAutofocus`, 2 `useLiteralKeys`, 1 each of `noUselessEmptyExport`, `noUselessTernary`, `noUnusedPrivateClassMembers`, `useExportType`) and no parse error.

**Commits:** see the Stage 1 commit below.

## Stage 2 — Reformat the repository and fix what Biome finds

**Depends on:** Stage 1.

**This stage:** Runs `biome check --write` over the whole repository as one commit that changes formatting and import order and nothing else, then fixes the lint diagnostics that remain: a rule that Reforma also switched off is switched off in the same way; anything else is fixed in the code or switched off with a one-line reason in `biome.json`. The reformat commit is separate from the fixes, and its hash goes into `.git-blame-ignore-revs`.

- [ ] Complete
  - [ ] One commit that only reformats (`style: reformat the repository with biome`), nothing else in it
  - [ ] `.git-blame-ignore-revs` names that commit, and `git config blame.ignoreRevsFile` is mentioned in `README.md`
  - [ ] `bunx biome check` reports no diagnostics
  - [ ] `bun run typecheck` and `bun run test` pass as they did on `next` before the stage (name any test that failed before)

**Files**

- every source file the formatter changes — one commit, no hand edits
- `biome.json` — rules switched off with a reason, where the owner's decision is not needed
- `.git-blame-ignore-revs` — create: the file git reads, there is no other home for it
- `README.md` — one line on `git config blame.ignoreRevsFile .git-blame-ignore-revs`

**Done when:** `bun run lint`, `bun run typecheck` and `bun run test` pass in the worktree, and the reformat commit changes only whitespace, line breaks, quotes, commas, parentheses and import order.
**Verify:** `bun run lint && bun run typecheck && bun run test`; compare the test counts with the main checkout; `git show --stat <reformat commit> | tail -1`; a build smoke with `./clowdy build` if it runs here.
**Commits:** None yet.

## Stage 3 — Remove ESLint

**Depends on:** Stage 2.

**This stage:** Deletes every `eslint.config.mjs`, the `packages/eslint-config` package, the ESLint dependencies of all `package.json` files and the lockfile, and turns the 15 `eslint-disable` directives into `biome-ignore` comments with the same reason, or removes them when Biome does not flag the line. The docs and the credits stop naming ESLint and the MIT copy of Reforma's config.

- [ ] Complete
  - [ ] No `eslint.config.mjs`, no `packages/eslint-config`, no `eslint` or `@stylistic` or `perfectionist` or `eslint-plugin-*` dependency left, and `bun.lock` is clean
  - [ ] No `eslint-disable` comment left; each is a `biome-ignore` with its reason or is gone
  - [ ] `AGENTS.md` (root Tooling, `apps/desktop`, `apps/daemon`, `packages/*`) and the GITFLOW check command name Biome; `.github/workflows` call the same scripts
  - [ ] `NOTICE`, `scripts/licenses-extra.md` and the regenerated `THIRD-PARTY-LICENSES.md` no longer name `packages/eslint-config`

**Files**

- `eslint.config.mjs`, `apps/*/eslint.config.mjs`, `packages/*/eslint.config.mjs`, `packages/eslint-config/**` — delete
- the `package.json` files and `bun.lock` — drop the ESLint dependencies
- the 12 source files with `eslint-disable` (`git grep -l eslint-disable`) — each directive
- `AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/daemon/AGENTS.md`, `packages/*/AGENTS.md`, `GITFLOW.md`, `.github/workflows/*` — the lint tool's name and commands
- `NOTICE`, `scripts/licenses-extra.md`, `THIRD-PARTY-LICENSES.md` — the eslint-config entry (`./clowdy licenses` regenerates the last)

**Done when:** `git grep -il eslint` finds nothing outside `.briefback/` and `bun.lock`-free history, and `bun run lint`, `bun run typecheck` and `bun run test` pass.
**Verify:** `git grep -il eslint -- . ':!.briefback'`, `bun install --frozen-lockfile`, `bun run lint && bun run typecheck && bun run test`.
**Commits:** None yet.

## Stage 4 — Merge back (only on the owner's word)

**Depends on:** Stage 3.

**This stage:** Brings the branch back to `next` without losing what the other agents wrote meanwhile. In the worktree: merge `origin/next`, run `bunx biome check --write`, commit that as `style: reformat after merging next` (and add its hash to `.git-blame-ignore-revs`), rerun the checks. Then, when the main checkout has no uncommitted work, from it: `git merge maksim-kachurin/biome`, push `next`, `./clowdy worktree remove biome`, `git branch -d maksim-kachurin/biome`.

- [ ] Complete
  - [ ] `origin/next` is merged into the branch and the repository is reformatted again with one commit
  - [ ] The checks pass in the worktree
  - [ ] The main checkout is clean, the branch is merged into `next` and pushed, the worktree and the branch are removed

**Files**

- every file other agents changed since Stage 2 — formatting only, from the re-run
- `.git-blame-ignore-revs` — the second reformat commit

**Done when:** `next` holds the Biome tooling, no agent has uncommitted work lost, and `bun run lint` passes on `next`.
**Verify:** `bun run lint && bun run typecheck && bun run test` on `next` after the merge; `git status` clean.
**Commits:** None yet.

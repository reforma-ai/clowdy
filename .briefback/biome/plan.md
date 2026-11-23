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

**Commits:**

- `7ae9e42` chore: add biome for linting and formatting

## Stage 2 — Reformat the repository and fix what Biome finds

**Depends on:** Stage 1.

**This stage:** Runs `biome check --write` over the whole repository as one commit that changes formatting and import order and nothing else, then fixes the lint diagnostics that remain: a rule that Reforma also switched off is switched off in the same way; anything else is fixed in the code or switched off with a one-line reason in `biome.json`. The reformat commit is separate from the fixes, and its hash goes into `.git-blame-ignore-revs`.

- [x] Complete
  - [x] One commit that only reformats (`style: reformat the repository with biome`), nothing else in it
  - [x] `.git-blame-ignore-revs` names that commit, and `git config blame.ignoreRevsFile` is mentioned in `README.md`
  - [x] `bunx biome check` reports no diagnostics (one remains until the first Stage 3 commit: `packages/file-manager/eslint.config.mjs` imports `@clowdy/eslint-config`, which the file-manager boundary now forbids; the file is dead since Stage 1 and Stage 3 deletes it)
  - [x] `bun run typecheck` and `bun run test` pass as they did on `next` before the stage (name any test that failed before)

**Files**

- every source file the formatter changes — one commit, no hand edits
- `biome.json` — rules switched off with a reason, where the owner's decision is not needed
- `.git-blame-ignore-revs` — create: the file git reads, there is no other home for it
- `README.md` — one line on `git config blame.ignoreRevsFile .git-blame-ignore-revs`

**Done when:** `bun run lint`, `bun run typecheck` and `bun run test` pass in the worktree, and the reformat commit changes only whitespace, line breaks, quotes, commas, parentheses and import order.
**Verify:** `bun run lint && bun run typecheck && bun run test`; compare the test counts with the main checkout; `git show --stat <reformat commit> | tail -1`; a build smoke with `./clowdy build` if it runs here.
**Scope notes (recorded while building):**

- The reformat ran as `biome check --write --linter-enabled=false` (formatter and import order only; it needed two passes, the formatter is not idempotent in one place of `apps/daemon/src/runs/service.ts`) and touched 1234 files (+71617 -29819: 770 `.ts`, 422 `.tsx`, 31 `.css`, 11 other). It was checked against HEAD with a script that parses every changed file (Babel for TS/JS, PostCSS for CSS, JSON) and compares the trees: everything equal apart from parentheses, a one-member union written with a bar, `export` statements merged and sorted, and `a && (b && c)` or `a ?? (b ?? c)` flattened. Side-effect imports were not moved across. The renderer built with Vite from the old and the new tree has the same files and the same CSS rules; the only change is that one CSS module (`ProjectSelect`) lands 19 rules earlier among unrelated modules, because Biome sorts `./ProjectSelect.module.css` before `./projectDialogs` (nothing styles one element with both).
- After the reformat, before any fix: typecheck and every test count equal the baseline (daemon 2244 pass / 0 fail, desktop 4508 with the same `AbortError`, the rest unchanged).
- Lint findings (36): the 22 control-character regexes (6 files) stay, as the ESLint directives did, with a `biome-ignore` and a reason; the 4 comma operators and 2 literal keys of tests are written plainly; `noUselessTernary`, `useExportType`, `noUselessEmptyExport` and the unused private `options` of `MapperV2` are fixed in the code; the 4 deliberate `autoFocus` attributes (the quick search input, the side panel size picker, two Modal tests) get a `biome-ignore` with a reason. No rule was switched off in `biome.json`; every rule that fired is fixed or suppressed on its line.

**Commits:**

- `7f907d4` style: reformat the repository with biome
- `7272ed1` chore(daemon): tell biome which regexes mean to match control characters
- `d25f98a` refactor(test): write the comma operators and string keys of four tests plainly
- `2f7ce82` refactor: drop four things biome finds useless
- `2c9b9a4` chore: keep the four deliberate autoFocus attributes with a reason for biome
- `aca7c60` chore: make git blame skip the biome reformat

## Stage 3 — Remove ESLint

**Depends on:** Stage 2.

**This stage:** Deletes every `eslint.config.mjs`, the `packages/eslint-config` package, the ESLint dependencies of all `package.json` files and the lockfile, and turns the 15 `eslint-disable` directives into `biome-ignore` comments with the same reason, or removes them when Biome does not flag the line. The docs and the credits stop naming ESLint and the MIT copy of Reforma's config.

- [x] Complete
  - [x] No `eslint.config.mjs`, no `packages/eslint-config`, no `eslint` or `@stylistic` or `perfectionist` or `eslint-plugin-*` dependency left, and `bun.lock` is clean
  - [x] No `eslint-disable` comment left; each is a `biome-ignore` with its reason or is gone
  - [x] `AGENTS.md` (root Tooling, `apps/desktop`, `apps/daemon`, `packages/*`) and the GITFLOW check command name Biome; `.github/workflows` call the same scripts
  - [x] `NOTICE`, `scripts/licenses-extra.md` and the regenerated `THIRD-PARTY-LICENSES.md` no longer name `packages/eslint-config`

**Files**

- `eslint.config.mjs`, `apps/*/eslint.config.mjs`, `packages/*/eslint.config.mjs`, `packages/eslint-config/**` — delete
- the `package.json` files and `bun.lock` — drop the ESLint dependencies
- the 12 source files with `eslint-disable` (`git grep -l eslint-disable`) — each directive
- `AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/daemon/AGENTS.md`, `packages/*/AGENTS.md`, `GITFLOW.md`, `.github/workflows/*` — the lint tool's name and commands
- `NOTICE`, `scripts/licenses-extra.md`, `THIRD-PARTY-LICENSES.md` — the eslint-config entry (`./clowdy licenses` regenerates the last)

**Done when:** `git grep -il eslint` finds nothing outside `.briefback/` and `bun.lock`-free history, and `bun run lint`, `bun run typecheck` and `bun run test` pass.
**Verify:** `git grep -il eslint -- . ':!.briefback'`, `bun install --frozen-lockfile`, `bun run lint && bun run typecheck && bun run test`.
**Scope notes (recorded while building):**

- ESLint restrictions found in the old configs: only the daemon's `no-restricted-imports` of the root of `@clowdy/lib`, ported to an `apps/daemon` override of `noRestrictedImports` (same message; a throwaway file importing `@clowdy/lib` was flagged and one importing `@clowdy/lib/checklist` was not). The desktop, components, lib, protocol, styles, constants and system-skills configs held nothing but the shared preset and `dist`-type ignores; file-manager's held no boundary at all (see Stage 1 notes).
- Dropped as Reforma dropped them: `react-hooks` (rules-of-hooks, exhaustive-deps and the compiler rules such as `refs` and `set-state-in-effect`), `react-refresh/only-export-components`, perfectionist's ordering of exports, JSX props and object keys, `@stylistic/brace-style: stroustrup` (Biome puts `} else {` on one line), and the `no-unused-vars` that ESLint already left to `tsc` for TypeScript (`tsc` has `noUnusedLocals: false`, so nothing checks unused code in `.ts` and `.tsx`, as before). Biome's counterparts `useHookAtTopLevel` (0 findings in Clowdy today), `useExhaustiveDependencies` (50), `noUnusedVariables` (13) and `noUnusedImports` (11) are off in the ported config.
- `eslint-disable` directives: the 6 `no-control-regex` ones became `biome-ignore` in Stage 2; the 7 `react-hooks/refs` and 3 `no-console` ones are removed, since Biome flags none of those lines.
- Three mentions of ESLint stay on purpose: the Biome bullet in `AGENTS.md` ("no ESLint"), a comment in `quickSearchSource.ts` that uses `.eslintrc` as an example of a hidden file name, and the generic checklist of the shipped `orchestrate` skill (`added ts-ignore or eslint-disable`), which is advice for the user's own projects.
- `NOTICE` and the credits now list `biome.json` among the files adapted from Reforma (Apache-2.0, like the rest), and the MIT exception for `packages/eslint-config` is gone. `bun.lock` lost 294 lines and gained 3 (older versions of `ajv`, `globals`, `json-schema-traverse` that ESLint used to hoist moved into the packages that needed them; no new version was resolved).
- Verified at the end of the stage: `bun install --frozen-lockfile` clean, `bun run lint` 11 of 11 packages plus the root files, typecheck with the same 7 errors in the daemon as before, the Vite renderer build, the daemon bundle and the main and preload bundle all build, and the full test run matches the baseline (protocol 71, lib 75, icons 23, daemon 2244 pass / 0 fail, components 257, file-manager 171, desktop 4508 with the known `AbortError`, system-skills validate passes).

**Commits:**

- `5b4cdd4` chore(daemon): keep the root of @clowdy/lib out of the daemon with biome
- `052a301` chore: remove eslint and its shared config
- `1f61b57` chore: drop the eslint directives that biome does not need
- `8edf061` docs: name biome and its style in the guides
- `1b1d7f6` docs: drop the eslint-config license entry and credit the biome configuration

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

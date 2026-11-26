# Skeleton checklist

The skeleton is the smallest repository in which every later agent can add a feature, run one command, and know whether it broke something. Build it yourself, in order, and tick each item only after you saw it work. Names such as `check` and `run` are the roles; use the ecosystem's usual script names (`bun run check`, `make check`, `cargo test`) and write the real ones in the README.

## 1. Repository

- [ ] Project root is the folder the user opened. Existing files are untouched. Put the app in a subfolder only if the folder already holds other things, and say so in the README.
- [ ] A git repository exists (`git init` if not). `.gitignore` covers dependencies, build output, local databases, `.env`, logs and OS files for this ecosystem.
- [ ] One package manager, one lockfile, committed. The runtime version is written down (README plus the ecosystem's version file or `engines` field).
- [ ] Layout is one level of obvious folders (source, tests, scripts), not a framework of empty packages. Add a folder when something lives in it.

## 2. Toolchain

- [ ] Strict typing on (TypeScript `strict`, or the language's strictest sensible setting: type hints plus a checker, `go vet`, `clippy`).
- [ ] Formatter and linter configured with the ecosystem's defaults; the formatter writes, the linter reports. Rules enforce conventions so prose does not have to.
- [ ] Test runner installed, with one real test that fails when the code is wrong. Not a test that asserts `true`.
- [ ] Dependencies the first milestone obviously needs are installed now (UI library, schema validation, database driver, test helpers), without version pins in the command, so slices rarely edit the manifest.

## 3. Commands

Two commands matter most. Both must work from a clean clone, from the project root, with no arguments, and exit non-zero on failure.

- [ ] `check`: typecheck, lint and the whole test suite, in one command, fast enough to run before every report (aim for under a minute). Prints one clear pass or fail line at the end.
- [ ] `run`: starts the product locally (dev server, or the CLI's `--help` and a sample call). A server reads its port from the environment and logs the address.
- [ ] Also, when the stack has them: `test` (tests only), `build`, `format`. Keep the list short.
- [ ] No command needs a global tool the README does not name, a cloud account or a network connection after install.

## 4. Layout built for parallel work

- [ ] Adding a feature means adding files, not editing shared ones. Examples: one file per route in a routes folder that is discovered automatically; one folder per screen that registers itself; migrations as numbered files in one folder; one test file next to each unit.
- [ ] Anything that must be edited by several features (route index, schema file, global styles, navigation) is either generated from the folder contents or listed in `architecture.md` as a shared file with a rule for who edits it.
- [ ] Config is read in one place from environment variables. `.env.example` lists every variable with a fake value. No real secret appears anywhere in the repository.

## 5. One thin path through every layer

- [ ] A single end-to-end example that touches each layer the product will have: for a web app, a page that calls an endpoint that reads and writes the database; for a CLI, one command that parses arguments, does work, prints output; for an API, one route with validation and storage.
- [ ] It has a test at the lowest useful level, and `check` runs it.
- [ ] It is named plainly (`health`, `example`, `hello`) so the first feature can replace or copy it.

## 6. README

Exactly these, in this order, each as a command the reader can paste:

- [ ] What it is (one sentence) and the runtime it needs, with the version.
- [ ] Install.
- [ ] Check.
- [ ] Run (and where to open it).
- [ ] Where the documents are: `.clowdy/docs/index.md`.

Nothing else. No badges, no roadmap, no aspirational features.

## 7. Documents

- [ ] `architecture.md` written from the repository as it is now (layout, commands, conventions, shared files, contracts)<!-- skill:docs -->, using the template of clowdy:docs<!-- /skill -->, in the project's main checkout. Every command in it is one you ran.
- [ ] `product.md` and `index.md` exist (you wrote them in steps 1 and 4 of the skill). `index.md` has the `architecture.md` line.

## 8. Prove it

Do this last, from a clean state, and write down what you saw.

- [ ] Delete installed dependencies and build output, install again with the README's command.
- [ ] Run `check`. It passes. Break the example test on purpose, run `check`, see it fail, then restore.
- [ ] Run `run`. For a server, request the thin path (`curl` or a headless browser) and see the real response. For a UI, load the page and confirm it renders without console errors. For a CLI, run the sample call and check its output and exit code.
- [ ] Stop the process. Nothing is left running.
- [ ] `git status` shows no generated files that should be ignored.

## 9. Commit

- [ ] One initial commit with a plain message, for example "Project skeleton: checks, run command, layout". It contains the lockfile and no secrets, build output or local data. Afterwards `git status` is clean.
- [ ] If git refuses because no author identity is set, do not invent one and do not change global settings. Leave the skeleton uncommitted and say so in the report ("Not run: initial commit, no git identity; the user needs to set one"). Everything else still counts as done.

## 10. Report

Put in a comment on the skeleton task and in the report to the manager: the check and run commands, the runtime version, the layout in one line, the shared files, any dependency you added beyond the stack decision, and what you saw in step 8. If a part could not be proven, say which and why; when the check or run does not work, the skeleton is not done.

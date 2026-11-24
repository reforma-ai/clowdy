# Starting recipes

These outlines name roles, not libraries or versions. Pick tools at scaffold time and add them without a version so the package manager resolves the current release. If a framework has an official starter command, read its current documentation first, run it, then delete what the product does not use and make `check` and `run` green. Every recipe ends in the same place: the skeleton checklist.

## TypeScript web app (screens plus a server)

Use when the product has pages people click through and one codebase is enough.

- Layout: `src/server/` (HTTP handlers, one file per route), `src/web/` (one folder per screen), `src/db/` (schema, migrations, queries), `tests/` mirroring `src/`, `scripts/`.
- Tooling: one runtime and package manager that is installed; strict TypeScript; a formatter and a linter; a unit test runner; a headless browser test runner for one end-to-end flow.
- Data: a local file database for the first milestone. A migration folder with numbered files. A seed script for demo data. All queries behind one module so the engine can change.
- Config: environment variables read in one file; validate them at start and fail with a clear message.
- Thin path: a page that loads data from an endpoint backed by the database, with one component test, one endpoint test and one end-to-end test.
- `check`: typecheck, lint, unit and endpoint tests. The end-to-end test runs in `check` only if it takes seconds; otherwise it is a separate `test:e2e` command named in the README, and you run it when you verify.
- Extension points: routes discovered from the routes folder; screens discovered from the screens folder; a shared UI folder for components used by two or more screens.
- Pitfalls: a client and server that disagree about types (share the type file, or generate the client from the schema); styling decisions made per screen (decide once in the skeleton: one stylesheet approach, one set of tokens).

## Node or Bun API (no UI)

Use when the product is a service other programs call.

- Layout: `src/routes/` (one file per resource), `src/db/`, `src/lib/` (small shared helpers), `tests/`.
- Tooling: as above. Validate every request and response at the edge with a schema library, and derive types from the schemas so there is one source of truth.
- Contract: write the route list (method, path, request, response, errors) in `architecture.md` before slices start. If the stack supports it, generate an API description from the schemas and check it in.
- Thin path: `GET /health` plus one resource with create and read, validation, storage and a test that calls the handler in-process (no network).
- `run`: start the server on a port from the environment. Smoke check: `curl` the health route and the resource.
- Errors: one error shape for every failure, decided in the skeleton, with a test.
- Pitfalls: ad-hoc error responses per route; a global singleton that makes tests order-dependent; long-running work inside request handlers (decide how background jobs will run before a slice needs them, and record it).

## Mobile and web hybrid (at a glance)

Use when people will use the product on phones. Decide the form first; it is a platform fork (`stack-criteria.md`).

1. Responsive web app, usable on a phone browser. Default. Everything in the web recipe applies. The milestone is checkable in a browser at a phone-sized viewport.
2. Installable web app: the same codebase plus a manifest and a service worker for install and basic offline use. Add it as its own slice after the screens work.
3. Native shell around the web app: only when the product needs a device feature the browser cannot give (reliable push, background work, deeper hardware access). Separate slice, separate verification.
4. Fully native or cross-platform app: only when the user requires it. It needs store accounts and often platform SDKs.

Agents verify locally with a browser at phone viewport. Simulators and device builds need installed SDKs and often user accounts: check what exists, and report the rest as blocked rather than claiming it works. Keep the business logic and data layer free of UI imports so a shell can be added later.

## Command-line tool

Use when the product is run from a terminal.

- Layout: `src/cli.*` (argument parsing and wiring only), `src/commands/` (one file per command), `src/lib/` (logic that the commands call), `tests/`.
- Tooling: a mature argument-parsing library or the language's standard one; strict typing; a test runner that can run the tool as a subprocess.
- Behavior to fix in the skeleton: `--help` on every command, a `--version`, results on stdout and messages and errors on stderr, exit code 0 on success and non-zero on failure, no output colors when stdout is not a terminal.
- Thin path: one command that reads input (argument, file or stdin), does the work in `lib/`, prints the result. Tests call `lib/` directly and run the real command for exit codes and output.
- `run`: `<tool> --help` and one sample call. Distribution (a single binary, a package) is a later slice.
- Pitfalls: logic inside command files (untestable); reading global user config without a flag to override it; destructive commands with no dry-run or confirmation.

## Other languages

Same roles, different tools. Pick the ecosystem's standard ones.

| Role | Python | Go | Rust |
| --- | --- | --- | --- |
| Environment and dependencies | project-local virtual environment, one dependency file plus a lock | modules (`go.mod`, `go.sum`) | Cargo (`Cargo.toml`, `Cargo.lock`) |
| Types and lint | type hints with a checker, a linter | `go vet` and a linter | `clippy` |
| Format | the community formatter | `gofmt` | `rustfmt` |
| Tests | the standard test runner plus a runner for parametrized cases | `go test` | `cargo test` |
| One-command `check` | a `Makefile`, task runner or script that runs checker, linter, tests | `make check` or a script | `cargo fmt --check && cargo clippy && cargo test` as one script |

In every language, `check` and `run` are each one command from the project root, listed in the README.

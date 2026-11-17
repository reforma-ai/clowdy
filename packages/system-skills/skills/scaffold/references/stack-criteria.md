# Choosing the stack

The manager described a product. You choose the technology, apply the criteria in order, and record the result as a decision (clowdy:docs, decision template). The first criterion that decides the question ends the discussion.

## Criteria, in order

1. **The user's constraints.** Language or platform they named, where it must run, accounts they already pay for, an existing repository or team they will hand it to, tools installed on this machine. A stated constraint beats every other criterion. If it makes the job harder, build it anyway and record the risk in the decision.
2. **Boring and well supported.** Mainstream and actively maintained. One obvious way to do common things. Plenty of documentation and examples, so agents rarely guess. Prefer one well-known framework over a new one. Prefer stable or long-term-support releases of runtimes.
3. **Verifiable locally.** An agent can run the whole product and its tests on this machine without a cloud account, a credit card or a network. Data lives in a local file or a local database. A user flow can be driven headless: HTTP calls for an API, a headless browser for a web UI, process exit codes and output for a CLI.
4. **Fewest moving parts.** One language across the product when it fits, one repository, one package manager, no separate service until a requirement needs it. No second database "for later". No microservices.

When two options tie, choose the one with fewer files to explain and less to configure.

## Defaults when nothing is stated

These are starting points, not rules. Criteria 1 and 3 can overturn each of them.

| Product shape | Start with |
| --- | --- |
| Web app with screens | One TypeScript codebase: server and web UI together, local database file |
| API or backend service | TypeScript on the installed runtime (Bun or Node), schema validation at the edge, local database file |
| Command-line tool | The language the user's team already uses; else TypeScript on the installed runtime, or Go or Python when a single binary or data work matters |
| Used on a phone | A responsive web app first; a native shell only when a device feature needs it (see `recipes.md`) |
| Data or automation scripts | Python, with a project-local environment and a test runner |
| Static or content site | A static site generator; no server |

Data: a local file database (SQLite) for one site, one team or one server. A hosted relational database when several servers or many people write at once, or when the user already has one. Keep all queries in one folder so the choice can change.

Auth: none when the product is single-user or local; one shared password for a small private admin page; managed login (email link or an identity provider) when real accounts are needed. Never write your own password storage or token scheme.

Hosting: decide later unless the user named a place. Do not choose anything that blocks it: configuration from environment variables, no absolute local paths in code, one command to build.

## Check the machine first

Run the version command of the toolchain you are about to pick (`bun --version`, `node --version`, `python3 --version`, `go version`, `cargo --version`, `git --version`). Prefer what is installed and recent enough. If the best tool is missing:

- an install needs no admin rights and no user input: install it and say so in the decision;
- otherwise choose the next best installed option, or report the missing tool as a blocker and continue with the parts that do not need it.

## Red flags

- It needs a paid account, an API key or a network connection before the tests can run.
- A niche framework with one maintainer, or a pre-release major version.
- A build step nobody on the team can run, for example a native toolchain that is not installed.
- Code generation that must be re-run by hand after every change.
- Heavy monorepo tooling for a single application.
- Two languages with no requirement behind it.
- A choice made because it is fashionable, not because of a criterion above.

## Check current versions

Versions in your memory are old. At scaffold time:

1. Ask the package manager, not memory: `npm view <package> version`, `bun info <package>`, `pip index versions <package>`, `go list -m -versions <module>`, `cargo search <crate>`.
2. Add dependencies with the package manager's add command without a version, so it resolves the current release. The lockfile pins what it resolved. Commit the lockfile.
3. For a scaffolding tool or framework quick start, read its current documentation before running it. Commands change.
4. Write the runtime version in the README (or the ecosystem's version file) so a new machine uses the same one.

## Record the decision

One record for the stack, `decisions/<date>-stack.md`, in the decision template of clowdy:docs. In Options put the chosen stack, the closest alternative, and the reason it lost, citing the criterion number. Add `Assumptions` for anything unverified (expected size, who hosts it). Autopilot writes it immediately with `Decided by: autopilot`. In semi-manual the user's answers on platform, hosting, data and sign-in go into the settled record of clowdy:semi-manual (`Decided by: user (semi-manual)`), and your stack choices under "Decided by the agent".

## Semi-manual: the four forks that change the product

Ask only these, one `ask_user` card each (shape and rules: clowdy:semi-manual), only when the brief leaves the fork open and the answer changes what the user gets. Write each question in manager words, give two to three options, name the consequence in time, cost or ability, and mark the one you recommend. Together with any product question from step 1 of scaffold they make one round of at most four cards.

| Fork | Question | Typical options (with consequence) |
| --- | --- | --- |
| Platform | Where do people use it? | In a browser (nothing to install, works everywhere), installed on a phone (app store accounts, weeks of review), on their computer (installers, updates) |
| Hosting | Where should it run? | On your computer only for now (free, nobody else can open it), on a hosting service (monthly cost, reachable by everyone, needs an account), your own server (you or someone maintains it) |
| Data | What does it keep, and for how long? | Only what people submit, in a simple file (cheap, fine for one shop), a proper database (needed for many users or reports), personal data of real people (needs a retention and privacy decision) |
| Sign-in | Who signs in? | Nobody (anyone with the link can use it), one shared password for the owner (simple), personal accounts (email or an identity provider; adds a sign-up flow and password reset) |

Do not ask about language, framework, database engine, test runner, folder layout, or anything in criteria 2 to 4. Decide those and record them.

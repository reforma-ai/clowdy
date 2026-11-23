# Spec-driven formats: what the Docs tab should mount

Snapshot 2026-11-22. Question: for each spec-driven tool, which folders to mount as top-level groups in Docs, which files to show, and how to detect it. Sources are the tools' own repos and docs, read on that date. A claim without a source is marked UNVERIFIED. "Observed" means seen in a real public repository, not in the vendor docs.

Today's Docs scope is one root, `.clowdy/docs`, filtered to `*.md|*.markdown` (`apps/desktop/src/renderer/features/files/docsScope.ts`, `DOCS_ROOT`, `DOCS_SCOPE`, `isDocumentPath`). Other code reads that constant: quick search, `@doc` mentions, `openInFiles`, `openDocument`, the daemon's files tests. A registry replaces the constant in all of them.

## Comparison

| Format (version read) | Detect by | Root(s) to mount | Files to show | Archive |
| --- | --- | --- | --- | --- |
| Clowdy `.clowdy` | `.clowdy/docs/` exists | `.clowdy/docs` | `**/*.md` | none |
| Briefback | `.briefback/` exists | `.briefback` (work), `.briefback/docs` (durable) | `**/*.md`; `docs/**` is the durable tree | files are deleted after `document`, no archive folder |
| Spec Kit v1.4.3 (2026-11-19) | `.specify/` dir (the CLI's own check) | `specs`, `.specify/memory`, `.specify/bugs`, `.specify/assessments` | `**/*.md` under each | none; old feature folders stay |
| OpenSpec v2.1.1 (2026-11-19) | `openspec/specs` or `openspec/changes` dir | `openspec` | `specs/**`, `changes/**`, legacy `project.md` | `changes/archive/YYYY-MM-DD-<name>/` |
| Kiro (docs pages dated 2026-10-21, 2026-11-12) | `.kiro/specs` or `.kiro/steering` dir | `.kiro/specs`, `.kiro/steering` | `**/*.md` | none in the docs read |
| BMAD v6.12.4 (2026-10-14, npm latest) | `_bmad/config.toml`, else `_bmad/`, else `_bmad-output/` | `output_folder` read from `_bmad/config.toml`, default `_bmad-output` | `**/*.md` | none by the tool; an `archive/` folder seen in one repo, creator UNVERIFIED |
| BMAD v7 preview alpha (main branch) | same markers | `output_folder` (initiative store) | `**/*.md` | UNVERIFIED |
| Taskmaster 0.43.1 (2026-03-31) | `.taskmaster/` dir | `.taskmaster/docs` | `**/*.md` (PRD is `.txt`) | none |
| Tessl (tile 2.0.1) | UNVERIFIED | no root folder | `*.spec.md` anywhere | none |
| Cursor rules, AGENTS.md, CLAUDE.md | not documents | do not mount | none | none |

## Clowdy's own layout (`.briefback`)

Defined by the briefback skill (`~/.claude/skills/briefback/references/{research,plan,handoff,document}.md`) and `BRIEFBACK.md`. In this repo: 112 `.md` files, all tracked in git, plus `config.json` and one `.txt`.

```text
.briefback/
├── config.json                  # skill config, not a document
├── references.md                # hand-written, not skill-defined
├── <slug>/                      # one folder per feature, kebab-case
│   ├── plan.md                  # 19 in this repo; living file, stage checkboxes, Commits lines
│   ├── handoff.md               # 2; transient, overwritten by the next chat
│   ├── grill.md                 # 1 (agent-accounts); not skill-defined, ad hoc
│   └── research/index.md + <topic>.md     # 86 files; research map plus pages
│       └── probe-harness.ts.txt, reforma-agent/…   # stray non-md or nested notes
└── docs/<domain>/…              # durable human pages; does not exist in this repo yet
```

- Durable: `.briefback/docs/<domain>/*.md` (written by `document` when the project has no human docs tree), and the project's own docs tree (`docs/`, here `.clowdy/docs`) that `document` prefers when it exists.
- Working files: `<slug>/research/**`, `<slug>/plan.md`, `<slug>/handoff.md`. Per `document.md` step 5, they are deleted once packaged into a page; `.briefback/docs/`, `config.json` and other slugs are left. They are real documents while they live (committed here), so show them, in their own group, not mixed with `docs/`.
- Lifecycle signals: `plan.md` has `- [ ] Complete` stage checkboxes, nested outcome checkboxes and a `**Commits:**` line per stage; no front matter. Research `index.md` lists open questions. No status line elsewhere.
- Detection: `.briefback/` directory. `config.json` has `{ "version": 1, "components": [...] }` (UNVERIFIED that every install has it).

## GitHub Spec Kit

Sources: `github/spec-kit` main, release v1.4.3 (2026-11-19); `spec-driven.md`; `docs/overview/core.md`, `docs/quickstart.md`, `docs/how-to/{persisting-specs,evolving-specs,monorepo,spec-of-specs}.md`; `templates/`; `extensions/{git,bug,assess}/README.md`; `scripts/bash/{common,create-new-feature}.sh`. Real tree observed in `sitkoru/Sitko.Core`.

```text
<project>/
├── .specify/
│   ├── memory/constitution.md                 # human document
│   ├── templates/{spec,plan,tasks,checklist,constitution}-template.md   # noise
│   ├── scripts/{bash,python}/…                # noise
│   ├── extensions/<id>/{extension.yml,README.md,commands/*.md}          # noise, Markdown but tool files
│   ├── integrations/, workflows/, presets/    # noise
│   ├── bugs/<slug>/{assessment,fix,test}.md   # extension "bug" (opt-in)
│   ├── assessments/<slug>/{intake,research,problem,concept,decision}.md # extension "assess" (opt-in)
│   └── feature.json, init-options.json, integration.json, extensions.yml # state and config
└── specs/
    ├── 003-chat-system/                       # spec-driven.md example
    │   ├── spec.md  plan.md  research.md  data-model.md  quickstart.md  tasks.md
    │   ├── contracts/                         # API contracts, mostly yaml/json
    │   └── checklists/requirements.md         # made by /speckit.specify and /speckit.clarify
    ├── 20261027-150000-pdf-rendering/spec.md  # timestamp numbering, observed
    └── <epic-slug>/roadmap.md                 # spec-of-specs how-to
```

- Read: everything `.md` under `specs/**`, `.specify/memory/`, `.specify/bugs/`, `.specify/assessments/`. Skip: `.specify/{templates,scripts,extensions,presets,integrations,workflows}`, `contracts/*.{yaml,json}` (non-md anyway), agent command files (`.claude/commands/speckit.*.md`, `.github/prompts`, `.github/skills/**/SKILL.md`; exact path depends on the chosen integration, UNVERIFIED per agent).
- Detect: `.specify/` directory. The CLI errors `not a Spec Kit project: no .specify/ directory found` without it (`docs/overview/artifacts.md`). A bare `specs/` is not a marker: Spec Kit's own repo gitignores `specs/` (persisting-specs.md, "constitution-only" model), so a clone can hold `.specify/` and no `specs/`.
- Names: feature folder `NNN-slug` (sequential, 3 digits, grows past 999) or `YYYYMMDD-HHMMSS-slug` (git extension `branch_numbering: timestamp`). `specs/` is hard-coded to `$REPO_ROOT/specs` in `create-new-feature.sh`; the active feature can point elsewhere through `.specify/feature.json` (`feature_directory`, gitignored) or `SPECIFY_FEATURE_DIRECTORY` (env, never recorded in the repo).
- Lifecycle: no archive. Four documented persistence models (flow-back, flow-forward, living spec, constitution-only); flow-forward adds a new folder instead of editing, so old folders are history. `spec.md` template has `**Status**: Draft`, `**Feature Branch**`, `**Created**` lines (not YAML front matter). `tasks.md` is a checkbox list (`- [ ] T001 [P] [US1] …`, done is `[X]`).
- Monorepo: each member project has its own `.specify/` and `specs/` (`apps/web/.specify`, `apps/web/specs/001-…`); resolution takes the nearest `.specify/`. A root-level detector misses these.
- Configurable folders: the `.specify/` name is fixed; feature folder default is fixed (see above).

## OpenSpec

Sources: `Fission-AI/OpenSpec` main, release v2.1.1 (2026-11-19); `docs/{concepts,getting-started,cli,customization,migration-guide}.md`, `docs/stores-beta/user-guide.md`; `src/core/project-dir.ts` (`OPENSPEC_DIR_NAME = 'openspec'`).

```text
openspec/
├── config.yaml                  # schema, context, rules, optional `store:` pointer; not a document
├── specs/<domain>/spec.md       # current truth, one folder per capability
├── changes/
│   ├── <change-name>/           # active, e.g. add-dark-mode (kebab-case, no number or date)
│   │   ├── proposal.md  design.md  tasks.md
│   │   ├── .openspec.yaml       # optional metadata, not md
│   │   └── specs/<domain>/spec.md       # delta spec (## ADDED / MODIFIED / REMOVED Requirements)
│   └── archive/YYYY-MM-DD-<change-name>/   # same files; written by `openspec archive`
└── schemas/<name>/{schema.yaml,templates/*.md}   # custom workflows; noise
# legacy (migration guide): openspec/project.md (human text), openspec/AGENTS.md (agent file, delete)
```

- Read: `specs/**.md`, `changes/**.md` including `archive/`, legacy `project.md`. Skip: `schemas/**`, `AGENTS.md`, `config.yaml`. Custom schemas can add other artifact names (for example `research.md`), so match `**/*.md` under `changes/`, not fixed names.
- Detect: `openspec/specs` or `openspec/changes`. A folder with only `config.yaml` that holds `store: <id>` is a pointer to a planning repo elsewhere on the machine (stores beta); there is nothing local to mount. The CLI refuses `init` while such a pointer exists.
- Lifecycle: `openspec archive` merges the change's deltas into `specs/` and moves the folder to `changes/archive/YYYY-MM-DD-<name>/` (cli.md). Active vs done is the folder, not a status line. `tasks.md` is `- [ ] 1.1 …` with `## 1.` headings; `openspec validate --archived` checks that archived changes have all boxes ticked. A spec has `## Purpose` and `### Requirement:` / `#### Scenario:` headings, no front matter.
- Configurable: the root name `openspec` is a constant, not configurable. Stores (beta) relocate the whole root to another repo (`.openspec-store/store.yaml` marks it).
- Not confirmed as product: the repo's own `openspec/{initiatives,work,explorations}` folders. cli.md mentions an `initiative:` key in `.openspec.yaml`, nothing else documented. UNVERIFIED that users get these folders.

## Kiro

Sources: kiro.dev/docs `specs.md` (page updated 2026-11-12), `specs/{feature-specs,bugfix-specs,quick-spec,best-practices,plan}.md`, `steering.md` (2026-10-21), `configuration.md`, `ide/editor/multi-root-workspaces.md`. Observed in `sebsto/wispr` (`.kiro/` with `specs/`, `steering/`, `idea/`, `refactor/`).

```text
.kiro/
├── specs/                          # configuration.md: Specs live at project scope `.kiro/specs/`
│   ├── user-authentication/        # one folder per spec, kebab-case (best-practices.md)
│   │   ├── requirements.md         # bugfix specs write bugfix.md instead
│   │   ├── design.md
│   │   ├── tasks.md
│   │   └── .config.kiro            # observed, not documented
│   └── app-store-check-list.md     # loose files users add (observed)
├── steering/                       # product.md, tech.md, structure.md + user files
├── hooks/, agents/, skills/, settings/, powers/…    # config, noise
```

- Read: `.kiro/specs/**.md` and `.kiro/steering/**.md`. Skip: `hooks`, `agents`, `skills` (`SKILL.md` is an agent skill), `settings`, `powers`, `workflows`. `.config.kiro` is JSON, `{"specId": "<uuid>", "workflowType": "requirements-first", "specType": "feature"}` (observed once, UNVERIFIED in vendor docs); a Markdown filter drops it.
- Steering files carry YAML front matter that must be the first content (`inclusion: always|fileMatch|manual|auto`, `fileMatchPattern`, `name`, `description`). Spec files have none in the docs read. `AGENTS.md` is also accepted as steering (workspace root or `~/.kiro/steering`), which is an agent guide; leave it out.
- Lifecycle: no archive, no number or date in names, no status line. Progress is the task list: observed `- [ ] 1.` with nested `- [ ] 1.1` and trailing `_Requirements: 1.1, 1.2_` lines. The docs do not give the checkbox syntax (UNVERIFIED in docs, observed in `sebsto/wispr`).
- Detect: `.kiro/specs` or `.kiro/steering` directory. `.kiro/` alone is weak: it also holds hooks, MCP settings and skills, so test the subfolder, not the parent.
- Multi-root workspaces: each root has its own `.kiro` and Kiro merges them. Global steering `~/.kiro/steering` is outside the project: not mounted. Folder names are fixed; none configurable.

## BMAD-METHOD

Sources: `bmad-code-org/BMAD-METHOD`. Stable branch `V6.12` (release 6.12.4, 2026-10-14, npm `latest`, install `npx bmad-method install`): `src/bmm-skills/module.yaml`, `src/core-skills/module.yaml`, `docs/**`. Preview on `main`: v7 alpha ("release ETA mid-November 2026"; installed through `npx skills add`, not on npm): `docs/start/install-bmad.md`, `docs/plan/set-up-the-ticket-tree.md`. Observed config and trees in `redhat-cop/vault-config-operator`, `chenjackle45/SayIt`. Legacy: branch `V4` (4.44.2).

v6.12 output (observed `_bmad-output/` in two repos; paths and names match `module.yaml`):

```text
_bmad/                                   # install: config, scripts, agents; never mount
├── config.toml, config.user.toml        # installer-owned, four-layer TOML
├── custom/config.toml, config.user.toml # human overrides (win over install answers)
└── bmm/config.yaml                      # legacy copy, still shipped in 6.12
_bmad-output/                            # [core] output_folder, default
├── project-context.md                   # at the output root (observed)
├── planning-artifacts/                  # [modules.bmm] planning_artifacts
│   ├── product-brief-<name>-<date>.md, prd.md, architecture.md, epics.md, ux-*.md
│   ├── implementation-readiness-report-<date>.md, sprint-change-proposal-<date>.md
├── implementation-artifacts/            # [modules.bmm] implementation_artifacts
│   ├── <epic>-<story>-<slug>.md         # "Status: done" line under the title (observed)
│   ├── sprint-status.yaml               # machine
│   ├── epic-<n>-retro-<YYYY-MM-DD>.md, deferred-work.md, spec-*.md, tech-spec-*.md
│   └── archive/…                        # seen in one repo; creator UNVERIFIED
├── specs/spec-<slug>/{SPEC.md,stories.yaml,stories/<id>-*.md,RETROSPECTIVE.md}   # spec-backed epic (6.12 docs)
└── test-artifacts/                      # TEA module `test_artifacts`
docs/                                    # [modules.bmm] project_knowledge, default "docs"
```

- The docs folder is the one thing the user can choose: `module.yaml` asks "Where should planning artifacts be stored?" and so on; defaults `{output_folder}/planning-artifacts`, `{output_folder}/implementation-artifacts`, `docs`, `output_folder` `_bmad-output`. The answers land in `_bmad/config.toml`:

```toml
[core]
output_folder = "_bmad-output"
[modules.bmm]
planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"
implementation_artifacts = "{project-root}/_bmad-output/implementation-artifacts"
project_knowledge = "{project-root}/docs"
```

  Resolve with the four layers, highest first: `_bmad/custom/config.user.toml`, `_bmad/custom/config.toml`, `_bmad/config.user.toml`, `_bmad/config.toml` (`docs/customize/customize-bmad.md`). `{project-root}` is a literal placeholder; a value can be absolute (the docs show `/shared/org-planning-artifacts`), so it can leave the project. Older installs and 6.12's legacy skills read `_bmad/bmm/config.yaml` (CHANGELOG 6.12). BMAD v4 recorded locations in `.bmad-core/core-config.yaml` (`prd.prdFile: docs/prd.md`, `prdShardedLocation: docs/prd`, `devStoryLocation: docs/stories`, `qa.qaLocation: docs/qa`), all inside generic `docs/`.
- v7 preview: the same `output_folder` becomes an initiative store: `initiative-<slug>/initiative-<slug>.md`, `<type>-<slug>/<type>-<slug>.md` for brief, prd, architecture, `ux-<slug>/{DESIGN,EXPERIENCE}.md`, `tickets/tickets.toml`, `epic-*/epic-*.md`, `tickets/story-*.md`, and `backlog/bug-*.md`. The active initiative is `active_initiative` in `_bmad/custom/config.user.toml` (personal, gitignored). `bmad migrate method` moves a v6 tree into it. Shape may still change (alpha).
- Read: `**/*.md` under the resolved output roots. Skip: `_bmad/**` (agent and workflow instructions, `module-help.csv`, custom TOML), `sprint-status.yaml`, `tickets.toml`, `.memlog.md` (agent memory log written by `bmad-prd` and `bmad-ux`), `*.html` keepsakes. `docs/` (project_knowledge) only when the user opts in: it is the project's generic docs folder.
- Lifecycle: story file name is `<epic>-<story>-<slug>.md`; epic retrospectives are date-suffixed; status is a `Status:` line (observed values `done`; the set of values UNVERIFIED, also kept in `sprint-status.yaml`); spec-backed epics track in `stories.yaml`; `SPEC.md` is written only by `bmad-spec` ("Do not hand-edit it").
- Detect: `_bmad/config.toml` (v6.12), `_bmad/` (older or partial), then bare `_bmad-output/` with the default name. Some projects gitignore `_bmad/`, so the output folder must also count on its own, but only with the default name; a custom `output_folder` is readable only when `_bmad/config.toml` exists.

## Second tier

- **Taskmaster** (`eyaltoledano/claude-task-master`, `task-master-ai@0.43.1`, 2026-03-31; README, `docs/configuration.md`, `docs/task-structure.md`, tree of the repo's own `.taskmaster/`): `.taskmaster/{config.json,state.json,tasks/tasks.json,reports/*.json,docs/,templates/}`. Tasks and reports are JSON (machine). Documents are `docs/prd.txt` (plain text PRD, README: "Create your PRD at `.taskmaster/docs/prd.txt`") and `docs/**/*.md` (observed research notes `research/2025-06-14_<slug>.md`, plans). Mount `.taskmaster/docs` with `**/*.md`; the `.txt` PRD falls outside the Markdown-only rule. Detect: `.taskmaster/` (the legacy `scripts/prd.txt` and `.taskmasterconfig` are in the migration doc). Per-task `task_NNN.txt` files: UNVERIFIED.
- **Tessl** (Spec Registry open beta, Framework closed beta, blog 2025-09-23; `tessl-labs/spec-driven-development` tile 2.0.1, `docs/spec-format.md`): specs are `*.spec.md` files with YAML front matter (`name`, `description`, `targets`) and `[@test]` links, placed next to the code (`calculator.spec.md` targets `../src/calculator.py`). No fixed root, so it cannot be a mounted folder; it would be a search-style group over `**/*.spec.md`. `tessl.json`, `.tessl/` layout: UNVERIFIED. Do not build it now.
- **Cursor rules** (cursor.com/docs/context/rules, no date shown): `.cursor/rules/**/*.mdc`, front matter `description/globs/alwaysApply`; the page names `.mdc` (whether plain `.md` also loads: UNVERIFIED). Not Markdown by Clowdy's rule and not a document. **AGENTS.md** (agents.md): plain Markdown "README for agents", root and nested. **CLAUDE.md**: same class (Claude Code memory; `.taskmaster/CLAUDE.md` is one). All three are instructions for agents: out of Docs; they stay in Files. This matches `document.md` ("UI strings and agent guides are out of scope").

## Recommended mounts

`include` and `exclude` are globs relative to `root`, POSIX separators. `detect` is evaluated once per project folder with `stat` only, no tree walk. `group` lets the UI fold small roots under one header.

```ts
export const DOC_SOURCES = [
  { id: 'clowdy',   label: 'Documents', root: '.clowdy/docs', include: ['**/*.md'], detect: { always: true }, create: true },
  { id: 'briefback-docs', label: 'Briefback docs', root: '.briefback/docs', include: ['**/*.md'], detect: { dir: '.briefback/docs' } },
  { id: 'briefback',      label: 'Briefback',      root: '.briefback', include: ['**/*.md'], exclude: ['docs/**'], detect: { dir: '.briefback' } },

  { id: 'speckit-specs', group: 'speckit', label: 'Spec Kit', root: 'specs', include: ['**/*.md'], detect: { dir: '.specify' }, sort: 'name-desc' },
  { id: 'speckit-constitution', group: 'speckit', label: 'Constitution', root: '.specify/memory', include: ['*.md'], detect: { dir: '.specify' } },
  { id: 'speckit-bugs', group: 'speckit', label: 'Bugs', root: '.specify/bugs', include: ['**/*.md'], detect: { dir: '.specify/bugs' } },
  { id: 'speckit-assess', group: 'speckit', label: 'Assessments', root: '.specify/assessments', include: ['**/*.md'], detect: { dir: '.specify/assessments' } },

  { id: 'openspec', label: 'OpenSpec', root: 'openspec', include: ['specs/**/*.md', 'changes/**/*.md', 'project.md'], exclude: ['schemas/**', 'AGENTS.md'],
    detect: { anyDir: ['openspec/specs', 'openspec/changes'] } },

  { id: 'kiro-specs',    group: 'kiro', label: 'Kiro specs',    root: '.kiro/specs',    include: ['**/*.md'], detect: { dir: '.kiro/specs' } },
  { id: 'kiro-steering', group: 'kiro', label: 'Kiro steering', root: '.kiro/steering', include: ['**/*.md'], detect: { dir: '.kiro/steering' } },

  // roots come from _bmad/config.toml (four-layer merge), deduplicated by containment; fall back to '_bmad-output'
  { id: 'bmad', label: 'BMAD', rootsFrom: 'bmad-config', include: ['**/*.md'], exclude: ['**/.memlog.md'],
    detect: { anyPath: ['_bmad/config.toml', '_bmad/bmm/config.yaml', '_bmad', '_bmad-output'] } },

  { id: 'taskmaster', label: 'Taskmaster', root: '.taskmaster/docs', include: ['**/*.md'], detect: { dir: '.taskmaster/docs' } },
] as const;
```

Rules:

1. A mount shows when its `detect` passes and its root has at least one included file; an empty root is hidden. `.specify/` after `init` with no specs shows nothing.
2. Do not mount tool folders wholesale: never `.specify`, `_bmad`, `.kiro`, `.taskmaster`, `.cursor`, `.claude`, `.github` as roots, because templates, extension READMEs, agent skills and command files are Markdown too.
3. Bare `specs/`, `docs/`, `specifications/`, `plans/`: never a marker. `specs/` counts only next to `.specify/`. `docs/` is mounted only when a tool config names it and the user opted in (BMAD `project_knowledge`; v4 `docs/prd*`, `docs/stories`).
4. `openspec/specs` is not Spec Kit's `specs/`: label mounts with the tool name so two "specs" groups stay distinguishable.
5. Two formats in one project (a migration, a monorepo with mixed teams, BMAD plus Spec Kit): mount both, no exclusivity. Group order is registry order (Clowdy, Briefback, then the table), never detection time. A path belongs to the mount with the longest root prefix, ties go to the earlier entry, so no file appears twice. When a resolved BMAD root nests inside another (`_bmad-output` and `_bmad-output/planning-artifacts`), keep the outer.
6. Tool-owned mounts do not offer "New document" (`create: false` is the default; only `.clowdy/docs` sets `create: true`, keeping `fileName` that adds `.md`). Editing stays allowed: Spec Kit says `spec.md` is the team's to edit; BMAD asks that `SPEC.md` is rewritten by its skill, so a warning there is optional.
7. Roots are read at the project folder only. Nested projects (Spec Kit's `apps/web/.specify`, a second `openspec/`) are not scanned in the first version.
8. A BMAD root can be absolute and outside the project; mount it only when the daemon's file provider can read it, else skip silently.
9. Sort hint: `NNN-` and timestamp prefixes sort newest first; `changes/archive` sorts last and may start collapsed.

## Open questions and UNVERIFIED

- Whether work-in-progress `.briefback` files (plans, handoffs) belong in Docs at all, or only `.briefback/docs/`. They are the repo's real planning record (112 tracked files) but the skill deletes them after `document`. Needs the owner's call.
- Front matter: Kiro steering, Tessl specs and BMAD templates start with `---` YAML. Not checked how `packages/components` `MarkdownEditor` shows it (`markdownDocument.ts` is modified in the working tree).
- BMAD v7 is alpha with a changing layout. Its docs gave "mid-November 2026" as the release ETA; on 2026-11-22 the `main` docs still said preview alpha, and v7 installs through `npx skills add`, so npm dist-tags (`latest` 6.12.4) say nothing about it. Support v6.12 first.
- BMAD story `Status:` values, whether `archive/` is tool-created, and the exact `docs/` content of `bmad-document-project`: UNVERIFIED.
- Spec Kit: agent command folder per integration, and how often teams set `SPECIFY_FEATURE_DIRECTORY` to a folder other than `specs/`: UNVERIFIED. `.specify/feature.json` is gitignored, so a clone cannot know.
- Kiro: checkbox syntax and `.config.kiro` come from one third-party repo, not from docs; hook file extension UNVERIFIED; no archive concept found, and absence of one in the docs read is not proof.
- OpenSpec: `initiatives/`, `work/`, `explorations/` status as a shipped feature; stores (beta) keep the root in another repo, reachable only through the machine-local registry (user data dir), so they are out of reach for a project-folder detector.
- Taskmaster per-task `task_NNN.txt`, Tessl `tessl.json` and `.tessl/`: UNVERIFIED. Cursor's date and `.cursorrules` support: not shown on the page.
- Windows: not tested; all registry roots are POSIX relative and `{project-root}` placeholders must be resolved with the OS path separator.
- Not run: no tool was installed or executed. All layouts come from docs, source, and public repositories as listed.

## Sources

- Spec Kit: https://github.com/github/spec-kit (v1.4.3), `spec-driven.md`, `docs/overview/{core,artifacts}.md`, `docs/quickstart.md`, `docs/how-to/{persisting-specs,evolving-specs,monorepo,spec-of-specs,contract-driven-development}.md`, `templates/spec-template.md`, `templates/tasks-template.md`, `extensions/{git,bug,assess}/README.md`, `scripts/bash/{common,create-new-feature}.sh`.
- OpenSpec: https://github.com/Fission-AI/OpenSpec (v2.1.1), `docs/{concepts,getting-started,cli,customization,migration-guide}.md`, `docs/stores-beta/user-guide.md`, `src/core/project-dir.ts`.
- Kiro: https://kiro.dev/docs/specs.md, `/specs/{feature-specs,bugfix-specs,quick-spec,best-practices,plan}.md`, `/steering.md`, `/configuration.md`, `/ide/editor/multi-root-workspaces.md`, `/ide/chat/artifacts.md`; index https://kiro.dev/llms.txt.
- BMAD: https://github.com/bmad-code-org/BMAD-METHOD (branch `V6.12`, `main`, `V4`), `src/{bmm,core}-skills/module.yaml`, `docs/customize/customize-bmad.md`, `docs/plan/*.md`, `docs/build/*.md`, `CHANGELOG.md`; npm registry `bmad-method` dist-tags.
- Taskmaster: https://github.com/eyaltoledano/claude-task-master (README, `docs/`, repo tree). Tessl: https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry/, https://tessl.io/registry/tessl-labs/spec-driven-development. Cursor: https://cursor.com/docs/context/rules. AGENTS.md: https://agents.md/.
- Observed real trees (public GitHub): `sitkoru/Sitko.Core` (Spec Kit), `sebsto/wispr` (Kiro), `redhat-cop/vault-config-operator`, `chenjackle45/SayIt`, `aniadev/android-stream-desk` (BMAD).

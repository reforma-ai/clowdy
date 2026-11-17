# Orchestrating many parallel coding agents locally

Researched 2026-11-17 on the user's Mac (32 GB RAM, 12 cores (8P+4E), macOS 26.4.1, git 2.49, bun 1.4.4, `claude` 2.1.322, `codex` 0.166). Companion notes: `claude-agent-sdk.md` and `codex-sdk.md`. Experiments live in `scratchpad/research/orchestration/`.

## Verdict

> **Superseded by the owner (2026-11-17):** worktrees are not created per executor and there is no daemon merge queue in the MVP. The orchestrator decides whether to work in the main checkout or in a worktree it creates with a tool, and merges itself. Sections 'Worktrees' and 'Integration' below are background only. See `plan.md` Decisions.

- The daemon itself should be the orchestrator runtime. An orchestrator run is an engine session that gets **our own MCP/dynamic tools**: create and update tasks, spawn an executor run bound to task ids, inspect children, cancel. The engine's built-in subagents (Claude `Agent`/`Workflow`, Codex `spawn_agent`) are fine for short read-only helpers inside a run, but they are not the product's agent tree.
- Every run that writes code gets its own worktree on its own branch. The integration step is a **serialized merge queue for each (repo, target)**: `git merge-tree` to detect conflicts, checks run on the merged commit in an integration worktree, then a compare-and-swap ref update. All of this is prototyped and works (see below).
- "Thousands of agents" is a queue size, not a concurrency level. On this Mac the realistic number of **active write-runs is 6–12**. Read-only runs are cheaper. The binding limit is the subscription windows (Claude Max: 5-hour plus weekly; this user's Codex is **Plus**: 5-hour plus weekly), not CPU. The scheduler needs a global cap, per-engine caps, a memory floor, and "limited until resetsAt" states fed by the engines' rate-limit events.

## Key facts

### 1. What existing tools do (2025–2026)

| Tool | Isolation / branch | Integration | Agent tree / task link |
|---|---|---|---|
| Claude Code subagents | `isolation: worktree` makes a temp worktree, branched from the **default branch** (or `worktree.baseRef: "head"`), auto-removed if unchanged, locked while running | Results return to the parent. Background subagents report back as a **completion notification in a later turn** | Default **20 concurrent subagents per session** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), nesting up to **3 layers** (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). SDK events: `task_started/task_progress/task_updated/task_notification` |
| Claude Code `--worktree` | `.claude/worktrees/<name>/`, branch `worktree-<name>`; `.worktreeinclude` copies gitignored files (`.env`) | Manual | — |
| Claude dynamic workflows / **ultracode** | A JS script calls `agent()/parallel()/pipeline()/phase()`; per-agent worktree on request | The script does it; agents adversarially verify each other | **16 concurrent agents by default** (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, 1–256), **1,000 agents per run**, 4,096 items per `parallel()`. Works in `-p`/Agent SDK once the `Workflow` tool is allowed. Pauses at a usage limit **only in interactive sessions**. "Large workflow" warning above 25 agents or 1.5M tokens. Ultracode also lifts the 20-subagent cap |
| Claude agent teams | No worktrees: "partition the work" by file | — | Experimental; **interactive only (not `-p`/SDK)**, no nested teams. Shared task list (pending/in progress/completed plus deps, claims guarded by **file locking**), mailbox JSON files. Advice: 3–5 teammates; about **7x tokens** in plan mode |
| Codex CLI/app subagents | Inherit the parent's sandbox/approvals | The parent "waits until all requested results are available", then consolidates | `agents.max_concurrent_threads_per_session` (legacy `max_threads`; blogs say the default is 6). Custom roles in `.codex/agents/*.toml`. Non-interactive approvals fail back to the parent |
| Codex app worktrees | `$CODEX_HOME/worktrees`, **detached HEAD**; "Create branch here" uses a `codex/` prefix; keeps the **15 most recent**; `.worktreeinclude`; `codex exec --worktree` flag exists (0.166) | Hand off Local↔Worktree | Docs warn that worktrees "can use a lot of disk space" |
| Conductor | Workspace = worktree + branch at `~/conductor/workspaces/<repo>/<name>`; setup script; `CONDUCTOR_PORT` per workspace | "The workspace branch becomes the unit you review, push, and turn into a PR" | "Workspace isolation is development isolation, not a security boundary" |
| Vibe Kanban | Workspace = worktree + new branch; several sessions per workspace | Rebase / Merge buttons; merge moves the task to Done and cleans up the worktree | Task statuses To do → In Progress (attempt start) → In Review → Done. Ships an **MCP server (`create_task`, `start_task_attempt`)** so agents can create and start tasks: the same pattern we want for the orchestrator |
| Claude Squad | Worktree + **tmux session** per task (Windows needs WSL) | Diff review, push via `gh` | TUI list |
| Crystal → Nimbalyst | Crystal deprecated Feb 2026; Nimbalyst runs 3–10 Claude/Codex sessions in worktrees on a kanban | Diff review | Kanban card ↔ session |
| Cursor cloud agents | **VM per agent**, branch per agent with a static `cursor/` prefix | A PR plus **artifacts (screenshots, video, logs) as proof of verification** | Triggered by `@cursor` from GitHub/Linear/Slack |

Common shape: **one task attempt = one worktree + branch + one or more sessions**. Review happens on the branch diff. Merge is a separate explicit step. No tool merges many agent branches automatically with checks on the merged result; that part is ours to build.

### 2. Limits

#### Subscriptions (as currently documented)

- Claude: "Pro and Max plans have a five-hour session limit and a weekly limit". "Verified Ultra accounts don't have a five-hour session limit" (Ultra was renamed from Max 20x on 2026-10-30). Max and Ultra also have a **separate weekly limit for Fable**. Limits are shared across claude.ai and Claude Code. **No concurrent-session limit is documented.** The companion note found that this user is on **Claude Max**, so both the 5-hour and weekly windows apply.
- Claude retries: transient errors are retried **10 times** (`CLAUDE_CODE_MAX_RETRIES`, max 15). A 529 overload "is not your usage limit". `CLAUDE_CODE_RETRY_WATCHDOG=1` (plus `..._MAX_USAGE_LIMIT_WAIT_MS`) makes requests wait out 429/529 and usage resets: useful for unattended executors.
- Codex: "Local messages and cloud chats share your plan's usage allowance". Plus has a 5-hour window whose size depends on the model (for example GPT-6.1 Sol 15–160, GPT-6 Luna 350–3,000 local messages per 5h). "Pro plans currently have no five-hour limit". "Weekly limits may also apply", with no numbers. Credits can be bought. The companion note found **`plan_type=plus`** for this user.
- Fresh-run overhead (measured): a trivial Claude run had a **~24.5k-token** prefix. Three concurrent runs with the same config each read **24,554 tokens from cache with 0 cache writes**, so identical executor configs share the cache. Codex used **18.7k input tokens (11.8k cached)** to answer "OK". Every spawned run costs about 20k tokens before it does anything, so prefer fewer, longer executors over thousands of tiny ones.

#### Machine (measured on this Mac, smoke runs = "Reply with the word OK")

| Measure | Result |
|---|---|
| `claude -p --model haiku` peak RSS / wall | 222 MB / 6.1 s (API 1.4 s) |
| 4× `claude -p` concurrently | all succeeded, 215–225 MB each, 5.4 s wall total |
| `codex exec --ephemeral --json` peak RSS / wall | 164–200 MB / 6.5–7.9 s; 2 concurrent both OK |
| Long-lived interactive `claude` processes seen | 60–335 MB RSS |
| `git worktree add` | 0.26 s; **10 in parallel: 1.16 s**, no lock errors |
| `bun install --frozen-lockfile --ignore-scripts` in a fresh worktree | **1.6 s**, 879 packages, `du` 552 MB but **real disk delta 15 MB** (APFS clonefile) |
| Limits | `kern.maxprocperuid` 5333, `kern.maxfilesperproc` 122880, **free disk 25 GiB (95% used)** |

- Field reports of Claude Code memory leaks: multi-GB RSS in long sessions, and "~10 sessions → 30 GB memory pressure, macOS OOM" (issue 63318). Tool subprocesses (tsc, eslint, test runners, builds) often take 0.5–2 GB each and dominate per-run memory.
- File watchers: macOS FSEvents has no per-user watch cap. Linux inotify has `max_user_watches` (8192 on old kernels, RAM-scaled since ~5.11) and `max_user_instances` = 128. Windows ReadDirectoryChangesW has no hard cap but its buffer can overflow. **Do not watch worktrees, and do not start dev servers in each worktree.** Watch only the root `.factory/docs`, and learn run progress from engine events and `git status`.
- Realistic budget: about 24 GB usable once Electron, the daemon and the OS have theirs. At 0.5–2 GB per active write-run (agent plus its tool processes), that gives **6–12 active write-runs**, with read-only or analysis runs at about 0.3 GB each. Start with default caps of global 8, Claude 6, Codex 3.

### 3. Orchestrator mechanics

#### Custom tools versus engine subagents

| | Our tools (daemon-owned runs) | Engine built-in subagents |
|---|---|---|
| Visibility | Every run is in SQLite and the UI tree, with its own event stream | Opaque: only `task_*` summaries |
| Restart | Persisted; can be resumed by session id | Die with the parent process |
| Limits | Global, per-engine and memory caps across chats and projects | Per session only (20 Claude, about 6 Codex) |
| Cross-engine | A Claude orchestrator can spawn a Codex executor | Same engine only |
| Worktrees / tasks / cancel | Our control: many-to-many task links, subtree cancel | Limited |
| Cost | About 20k tokens of prefix per spawn, plus process start of about 6 s | Cheaper, shares the parent's cache |

Recommendation: the orchestrator gets `disallowedTools: ["Agent","Workflow"]` (and for Codex `agents.enabled=false`). Executors may keep `Agent` for read-only exploration.

#### Tool surface (one `clowdy` MCP server hosted by the daemon)

- Claude: in-process `createSdkMcpServer({ name: "clowdy", tools: [...] })`, or `{ type: "http", url, headers }`. The SDK MCP tool timeout is "effectively unbounded by default".
- Codex: app-server **dynamic tools** (see `codex-sdk.md`), or `mcp_servers.clowdy.url` (streamable HTTP; per third-party guides `tool_timeout_sec` defaults to 60).
- Authenticate every call with a **per-run bearer token**. The daemon derives the parent run from the token and never trusts a parent id the model supplies.

```ts
task_create({ title, body, parentTaskId?, dependsOn?: string[] }) -> { taskId }
task_update({ taskId, status?, body?, addDependsOn? })
run_spawn({ role: "executor"|"verifier"|"researcher", taskIds: string[], prompt,
            engine?: "claude"|"codex", workspace: "new_worktree"|"parent_worktree"|"readonly",
            baseRef?: string }) -> { runId, state: "queued" }      // returns immediately
run_children() -> [{ runId, role, state, stateReason, taskIds, branch, summary? }]
run_get({ runId }) -> { state, summary, diffStat, checks, reportPath }
run_cancel({ runId, reason })
// no blocking wait tool: ending the turn means "wait for my children"
```

#### Waiting without burning tokens: end the turn and get resumed (recommended)

1. The orchestrator calls `run_spawn` several times and then ends its turn. The daemon sees `result` while the run has live children and sets `waiting_children`.
2. When the children settle (by default all of them; or the first failure; debounced 10–30 s so results arrive as a batch), the daemon resumes the session: Claude `query({ prompt, options: { resume: sessionId } })`, Codex `resumeThread(id)`. The prompt is a compact notice per child: status, task ids, branch, checks, a summary of 10 lines or fewer, and the path to the full report. This mirrors Claude Code's own background-subagent "completion notification".
3. Idle cost: zero tokens and zero processes (the process exits). Resume cost: the context is reread from cache. The main-conversation cache TTL on a subscription was 1h in our smoke test (`ephemeral_1h_input_tokens`). After an hour without activity the next turn re-caches the whole context, so keep orchestrator context lean: summaries, never transcripts.
4. Optional optimisation: keep a hot Claude orchestrator in streaming-input mode (`streamInput` with a new user message) for N minutes, then `close()`. This keeps the cache warm and avoids a 6 s respawn, but costs about 200 MB while idle.

A blocking `wait_children` tool call is the wrong default: it keeps a process and an open turn alive, Codex MCP calls time out after about 60 s, the UI shows "running" instead of "waiting", and the run can't survive a daemon restart.

**Many-to-many run↔task**: `run_tasks(run_id, task_id, relation: primary|contributes|verifies|reads)`. "One active cycle per task" (spec §7) becomes a `task_attempts` row (a unique partial index on `task_id WHERE state IN active states`) that groups the runs working on that task. An orchestrator links to many tasks, and a task can have an executor, a verifier and a resolver at the same time.

### 4. Integration (prototype: `merge-queue.sh`, run against scratch worktrees)

```bash
tgt=$(git rev-parse <integration-tip>)
out=$(git merge-tree --write-tree --name-only --messages "$tgt" "$branch"); rc=$?   # no checkout needed
if [ $rc -eq 0 ]; then tree=$(head -1 <<<"$out")
  cand=$(git commit-tree "$tree" -p "$tgt" -p "$(git rev-parse "$branch")" -m "merge $branch")
  # check out $cand in an integration worktree (detached), run bun install + typecheck/lint/test/build
  git update-ref "refs/heads/$target" "$cand" "$tgt"     # CAS: fails if target moved
else  # rc=1: conflicted paths listed in $out
  # send it back: resolver run rebases the branch onto $tgt in its own worktree, re-runs checks, re-enqueues
fi
```

Result: 3 branches merged cleanly and the 4th was reported as `CONFLICT (content): Merge conflict in README.md`, without touching any working tree.

Rules:

- Exactly one queue worker per (repo, target).
- Serialize all ref and worktree mutations per repo with a mutex. Parallel `worktree add` worked, but `packed-refs` and `config` locks can race.
- Before enqueueing, require a clean worktree: the agent commits, and the daemon auto-commits leftovers with a marker.
- Retry a conflict at most 2 times, then mark the task `blocked` or `waiting_user`.
- Checks run on the **merged candidate**, not on the branch (spec §9).
- **Never move a branch that the user's checkout has checked out with a dirty tree.** Default target: a dedicated `clowdy/integration/<target>` branch, plus a "fast-forward `<target>`" action. When the user's checkout is clean, use `git merge --ff-only` there.
- MVP merges one branch at a time. Batching N branches with bisection on failure (Bors-style) can come later.

### 5. Recommended MVP daemon design

**Tables**: `tasks` (internal source of truth), `task_external_refs(provider, external_id, url, remote_updated_at)`, `task_attempts`, `runs(id, parent_run_id, root_run_id, role, engine, engine_session_id, state, state_reason, worktree_id, pid, pgid, started_at, ended_at, summary, usage_json)`, `run_tasks`, `worktrees(path, branch, base_sha, head_sha, status)`, `merge_queue(repo, target, branch, run_id, state, attempts)`, `run_events` (append-only; feeds the UI stream).

**Worktrees and branches**: put worktrees outside the repo at `~/.clowdy/worktrees/<project>/<run-short>`, so the user's checkout, watchers and `git status` never see them. Name branches `clowdy/<task-key>-<slug>/<run-short>` (for example `clowdy/T-42-auth-form/r7k2`), branched from the recorded `base_sha` of the integration tip. Run a per-project setup script (`bun install --frozen-lockfile`) and copy `.worktreeinclude` files. A verifier run gets a detached read-only worktree at the executor's head. Keep a worktree until its branch is merged or the user archives it.

**States** (spec §7) plus `state_reason` (`limit|memory|dependency|children|user_question|cancel_requested`):
`queued → running → (waiting_children ⇄ running) → succeeded|failed`; `running → waiting_user → running`; `queued|running → blocked` (dependency or external); any non-terminal state → `cancelled`; `running|waiting_children → interrupted` after a crash.

**Scheduler** (event-driven plus a 1 s tick). Admit the oldest high-priority `queued` run only when all of these hold:

- global and per-engine slots are free
- the engine is not `limited_until > now`
- free memory is above a floor (for example 4 GB, from `vm_stat` or `os.freemem`)
- its task dependencies are satisfied (otherwise `blocked`)
- the task has at most one active attempt
- there is a process-count guard (for example at most 64 descendant processes in total)

Priority: interactive chat orchestrator > executors > verifiers > background research.

#### Degradation

- Claude `rate_limit_event.rate_limit_info.status`: `allowed_warning` → stop admitting new Claude runs (drain). `rejected` → `limited_until = resetsAt`, re-queue failed runs with reason `limit`, and resume their session after the reset.
- Codex: read its rate-limit snapshots (app-server) or `turn.failed` → the same handling.
- Poll `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` for `five_hour/seven_day/seven_day_oauth_apps` utilization and resets for a UI meter. It is experimental and the name will change.
- For transient errors, rely on the engine's internal retries, then apply exponential backoff with jitter at the run level (30 s → 10 min, at most 3 times).

#### Cancellation of a subtree

1. Use a recursive CTE over `parent_run_id`, mark the runs `cancel_requested`, and drop queued ones straight to `cancelled`.
2. For live ones, call `query.interrupt()` then `close()` (or AbortController / Codex `TurnOptions.signal`). After a 5 s grace period, `kill(-pgid)`. Spawn each run detached in its own process group so tool subprocesses die too; on Windows use `taskkill /T /F`.
3. If the parent is not itself cancelled, tell it: "child X cancelled by user — do not restart it". Worktrees and branches are kept.

#### Restart recovery

- A single-instance lock file.
- On boot, `running` → `interrupted`. Verify each recorded `pid`+start time and kill orphans.
- A `waiting_children` run whose children all ended up `interrupted` → `interrupted`.
- `queued` stays queued.
- "Resume" creates a continuation run with the same `engine_session_id` in the same worktree; never resume silently.
- Merge-queue items in `checking` go back to `queued`.

#### Packaging and environment hazards

- Pass `pathToClaudeCodeExecutable`/`executable` (Claude) and `codexPathOverride` (Codex) explicitly.
- Strip `CLAUDE_CODE_*`/`CLAUDECODE` from the children's env.
- During this research a sibling experiment's compiled binary (`daemon-runtime/out/sdk-load`) kept spawning copies of itself: more than 2,000 processes and about 21 GB summed RSS within minutes. The apparent cause is self-exec through `process.execPath` in a `bun build --compile` binary. The process-count guard above exists for this case.

### Linear's agent model (out of scope now; for interface shape only)

- An agent installs as an **app user** (OAuth `actor=app`, scopes `app:assignable`, `app:mentionable`). Assigning an issue to it sets `Issue.delegate`; the human stays the assignee.
- An **AgentSession** is created on mention or delegation. Webhooks `AgentSessionEvent`: `created` and `prompted` (the user's reply is in `agentActivity.body`).
- The agent emits **AgentActivity**: `thought`, `action` (action/parameter/result), `elicitation`, `response`, `error`. The user-generated type is `prompt`. Only `thought`/`action` can be `ephemeral`.
- Session states `pending/active/error/awaitingInput/complete/stale`. Timing: ack within **10 s**, webhook response within 5 s, stale after 30 min.
- `plan` items (pending/inProgress/completed/canceled, replaced whole). `externalUrls` for PRs.
- Best practice: move the issue to the first `started` state when work begins.

Implications for our interface:

- `TaskProvider { pull(since), get, create, update(status), comment }` plus an optional `AgentSessionPort { open(runId, externalTaskId), publish(runId, activity), onPrompt(cb) }`.
- Our `run_events` kinds should map one-to-one onto thought/action/elicitation/response/error, and `waiting_user` onto `awaitingInput`.
- The external session maps to our root run or attempt, never to an individual executor (the spec already rules out one Linear user per subagent).
- `prompted` replies must route to a specific pending question id.

## Limits and risks

- Policy: the Agent SDK docs say that, unless previously approved, third parties may not offer claude.ai login or rate limits. Personal local use is the path the companion note found acceptable. Do not ship this to others.
- Subscription throughput, not RAM, is the ceiling. Twelve agents drain a 5-hour Claude Max window roughly 12× faster, and this user's Codex Plus window is small. Show utilization in the UI and default to modest caps.
- Claude Code memory leaks in long sessions: rotate long executors (fresh session plus a summary handoff), and watch RSS per pid to kill above a threshold (for example 4 GB).
- Disk is 95% full (25 GiB free). bun's clonefile makes `node_modules` cheap, but build outputs, `.turbo` and Electron downloads (postinstall was skipped in our test) are not. Garbage-collect worktrees: keep the N most recent plus every worktree with unmerged commits.
- Parallel edits to shared hot files (`bun.lock`, `package.json`, route registries) cause serial conflicts. The orchestrator should split work by file ownership and leave lockfile changes to the merge step.
- Not measured: Windows (bun hardlink backend, process groups, Defender scanning worktrees).

## Open questions

- Does Claude Max have a real concurrent-session ceiling? 4 parallel runs worked, so try 8–16 with the tiny prompt before choosing the default cap.
- Integrate into a dedicated `clowdy/integration/*` branch by default, or into the branch the user names? (This affects the dogfooding loop.)
- Codex executors through app-server (one process, many threads) from day one, or SDK first? See `codex-sdk.md`.
- Linear needs public webhooks for `created`/`prompted`. Is polling activities enough for the local MVP?

## Sources

- Claude Code: [subagents](https://code.claude.com/docs/en/sub-agents), [agent teams](https://code.claude.com/docs/en/agent-teams), [dynamic workflows / ultracode](https://code.claude.com/docs/en/workflows), [worktrees](https://code.claude.com/docs/en/worktrees), [parallel agents overview](https://code.claude.com/docs/en/agents), [errors & retries](https://code.claude.com/docs/en/errors), [costs](https://code.claude.com/docs/en/costs), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript). Types from `@anthropic-ai/claude-agent-sdk@0.3.325` `sdk.d.ts` (`SDKRateLimitInfo`, `TerminalReason`, `SDKTaskNotificationMessage`, MCP `timeout`).
- Claude limits: [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [Ultra five-hour removal coverage](https://letsdatascience.com/news/anthropic-removes-five-hour-claude-limit-for-verified-ultra-56c3c5dc), [memory issue 63318](https://claudeissues.com/issue/63318-bug-excessive-ram-usage-with-multiple-parallel-chats-10-sessions-30-gb-memory-pr).
- Codex: [pricing/limits](https://learn.chatgpt.com/docs/pricing), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [MCP config](https://developers.openai.com/codex/mcp). Types from `@openai/codex-sdk@0.169.0`.
- Tools: [Conductor worktrees](https://www.conductor.build/docs/concepts/git-worktrees), [Vibe Kanban workspaces](https://www.vibekanban.com/docs/workspaces.md), [Vibe Kanban completing a task](https://vibekanban.com/docs/core-features/completing-a-task), [Vibe Kanban MCP overview](https://quochuydev.github.io/tech-research/researching/vibe-kanban-overview.html), [Claude Squad](https://github.com/smtg-ai/claude-squad), [Crystal → Nimbalyst](https://github.com/stravu/crystal), [Cursor cloud agents](https://cursor.com/docs/cloud-agent), [Cursor branch prefix thread](https://forum.cursor.com/t/allow-disabling-branch-prefix-cursor-for-cloud-agent/161901).
- Linear: [Agents getting started](https://linear.app/developers/agents), [Agent interaction](https://linear.app/developers/agent-interaction), [Agent best practices](https://linear.app/developers/agent-best-practices).
- inotify: [kernel patch (Waiman Long)](https://lore.kernel.org/lkml/20201026204418.23197-1-longman@redhat.com/).

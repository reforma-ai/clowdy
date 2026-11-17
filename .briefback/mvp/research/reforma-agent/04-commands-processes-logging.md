# Reforma agent catalog 04: shell commands, background processes, logging

Source repo: `/Users/bionic/WORK/Reforma/reforma` (read-only). Paths below are relative to it; `src/` means `apps/sandbox/src/`.
Read first: `apps/sandbox/AGENTS.md`, `.briefback/docs/sandbox/shell.md`, `.briefback/docs/operations/error-reporting.md`, `.briefback/docs/desktop/local-projects.md`, `apps/desktop/AGENTS.md` (section Logs).
Everything marked "verified" was read in code. "Not run" means I did not execute it (read-only rule). Line counts are for sizing a port.

Two ways of judging each part: **(a)** code stays on the Vercel AI SDK loop, **(b)** an engine (Claude Agent SDK / Codex SDK) owns the loop and only logic/prompts/schemas are reused.

## 1. Summary

- The reusable asset is the **process layer** `src/core/process/*` (about 2.5k lines): spawn, tree kill, command registry, ring buffer, JSONL disk log, PTY host. It does not depend on the agent loop. It is needed under (a) and (b), because the Clowdy daemon runs its own commands (setup scripts, tests, dev servers, terminals) whatever the engine does.
- The **Bash tool** (`src/chat/agent/tools/bash/Bash.ts`, 349 lines) is a thin `tool()` from `ai` on top of that layer. Under (b) the engine ships its own shell tool, so Bash.ts is only a source of ideas: tail+spill output, background receipt, poll by id, wake the thread when a job finishes.
- Reforma already did the **macOS/Windows homework** for a local controller: Git Bash on Windows, `taskkill /T /F`, libproc tree walk on macOS, env pick-list, a stop ladder (close stdin, SIGTERM, SIGKILL), a TMPDIR-marker orphan sweep, Anthropic's `sandbox-runtime` for confinement. Windows has no confinement at all, and no CI job runs on Windows.
- Logging is simple: a console logger with a `[Name]` prefix, one mirrored JSONL channel (`sandbox.jsonl`), per-command JSONL files, Sentry (`logger.critical` = report, `logger.error` = log only). No run/thread id on log lines, no rotation, no size caps.
- Section 9 lists 15 defects and traps (read in code; the ones marked "not run" or "inferred" are not executed). Fix them while porting: abort ignored by a foreground command, SIGTERM never escalates on kill, stdin is never closed, unbounded buffers.

## 2. Part catalog

| Part | File:symbol | What it does | Deps | Verdict |
| --- | --- | --- | --- | --- |
| Bash tool | `src/chat/agent/tools/bash/Bash.ts`: `Bash`, `pollCommand`, `keepTail`, `attachDeliver` | One tool, four modes: run, run in background, poll by id, kill by id | `ai` `tool`, zod, `processRegistry`, `ThreadSession`, `runtimeFromToolOptions`, `validatePath`, `config` | PORT-WITH-CHANGES under (a); REWRITE-USING-IDEA under (b) |
| Command rewrite | `.../bash/rtk-rewrite.ts`: `rewriteBashCommand` | Pipes the command through `rtk rewrite` (rtk-ai/rtk 0.49.0) to get token-compact output; falls back to the original | `rtk` binary (`RTK_VERSION` in `apps/sandbox/Dockerfile`), `safeBaseEnv` | PORT-WITH-CHANGES (optional, bundle the binary) |
| Host deny-list | `.../bash/host-policy.ts`: `refuseHostMutation` | Regex refusal of apt/sudo/brew/playwright/.deb/pipe-to-sh | none | SKIP (tied to the cloud image) |
| Output spill | `src/chat/agent/tools/shared/tool-result.ts`: `spillIfLarge` | Over 24 KiB: write to `AGENT_TMP_DIR/tool-output/<uuid>.txt`, return a "Read this file" pointer | `config.AGENT_TMP_DIR` | PORT-AS-IS |
| Spawn | `src/core/process/spawn.ts`: `spawn`, `BunProcess`, `normalizeSpawnOptions`, `buildInvocation` | Env build, cwd check, `Bun.spawn`, stream readers, write/endStdin/kill | Bun APIs, `config`, `validatePath`, `bwrap.ts` | PORT-WITH-CHANGES |
| Tree kill | `spawn.ts`: `killProcessTree`, `collectDescendantPids`, `libprocChildPids`, `readChildrenMap` | Kill a process and all descendants on Linux, macOS, Windows | `bun:ffi` (macOS), `ps`, `/proc`, `taskkill` | PORT-WITH-CHANGES |
| Command runner | `src/core/process/command-runner.ts`: `CommandRunner` (250 lines), base `process-runner.ts`: `ProcessRunner` (314) | State machine QUEUED/RUNNING/EXITED/ERROR/KILLED, timeout timer, ring buffer + disk log + events, `runSync`, `waitForExit` | `@reforma/types`, `config`, logger, `EventEmitter` | PORT-WITH-CHANGES |
| Registry | `process-registry.ts`: `ProcessRegistry`, `processRegistry` singleton | id to runner map, GC, `killAll`, stats, disk fallback for output | `config.COMMAND_TTL_MS`, `generateCommandId` (`ai` `createIdGenerator`) | PORT-WITH-CHANGES |
| Ring buffer | `ring-buffer.ts`: `RingBuffer` (45 lines) | Last N output chunks in memory | `config.OUTPUT_LINES` | PORT-AS-IS |
| Disk log | `disk-log-store.ts`: `CommandLogWriter`, `readCommandLog` | JSONL per command, tail read in 64 KiB blocks from the end | `config.LOG_DIR` | PORT-WITH-CHANGES (add rotation/caps) |
| Orphan reaper | `spawned-pid-registry.ts`: `recordTrustedRootPid`, `reconcileOrphanTrustedProcesses` | Persists root PIDs to `LOG_DIR/spawned-pids.txt`, SIGKILLs those trees after a controller restart | `killProcessTree` | REWRITE-USING-IDEA |
| Shell choice | `shell.ts`: `getShellCommand`; `default-shell.ts`: `findDefaultShell` | `[DEFAULT_SHELL, -c or -lc, cmd]`; Git Bash lookup on Windows | `config.DESKTOP` | PORT-WITH-CHANGES |
| Env + isolation | `bwrap.ts`: `safeBaseEnv`, `BASE_ENV_ALLOWLIST`, `buildBwrapArgv`, `assertProcessIsolation` | Env allowlist (idea) and bubblewrap wrapping (Linux only) | `bwrap` binary | env list REWRITE-USING-IDEA; bwrap SKIP |
| PTY terminals | `terminal-runner.ts` (247), `terminal-registry.ts` (226), `pty-host.cjs` (104), `spawn.ts`: `PtyProcess`, `spawnPty` | Interactive shell on node-pty (ConPTY on Windows), headless xterm mirror for reattach | `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `node` | PORT-WITH-CHANGES |
| Background mailbox | `src/chat/threads/thread-session.ts`: `registerBackgroundJob`, `enqueueBackgroundResult`, `takeBackgroundResults`, `dropRunningBackgroundJobs`, `onThreadMailbox` | In-memory job list per thread, unread results, wakeups | `ThreadSession`, `publishState` sync channel | REWRITE-USING-IDEA |
| Result injection | `src/chat/agent/helpers/step-notes.ts`: `takeStepNotes`; `.../tools/get-background-result/GetBackgroundResult.ts` | Puts finished jobs into the next step as a user-role note, or on explicit tool call | `ThreadSession`, `processRegistry`, `spillIfLarge` | REWRITE-USING-IDEA |
| Idle wakeup | `src/chat/threads/continue-thread.ts`: `wakeForBackgroundResults`, `runWakeup`, `deliverBackgroundResult` | Starts a new run on an idle thread when a job finishes | `ThreadSession`, billing, `controlLease` | REWRITE-USING-IDEA |
| Non-process bg work | `src/chat/agent/helpers/background-thread.ts`: `runBackgroundWork`, `stopBackgroundWork`, `resolveBackgroundThread` | Fire-and-forget async work with its own AbortController (subagents, installs); subagents may not use background Bash | `ThreadSession`, run scope | REWRITE-USING-IDEA |
| Stop jobs API | `src/api/chat/chat-stop-background-jobs.ts`: `stopThreadBackgroundJobs` | `POST /threads/:id/background-jobs/stop` (all or `ids`): abort work, else `command.kill()` | `processRegistry` | PORT-WITH-CHANGES |
| Task (dev server) | `src/core/task/task-controller.ts`: `TaskController` | Long-lived command + port readiness; stop = SIGTERM, 5 s, SIGKILL | `portMonitor`, `eventBus` | SKIP (preview/dev server); keep the stop ladder idea |
| Logger | `src/utils/logger.ts`: `createLogger`, `redact`, `writeToChannel` | Prefix console logger, `sandbox.jsonl` mirror, secret masking, `critical` to Sentry | `config`, `report-error.ts` | PORT-WITH-CHANGES |
| Sentry | `src/instrument.ts`; `src/utils/report-error.ts`: `captureSandboxError`, `wasReportedToSentry` | Init, scrubbing, run/thread tags, report-once via `cause` chain | `@sentry/bun`, `@reforma/constants`, `@reforma/lib/path` `replaceHomeDir` | PORT-WITH-CHANGES (opt-in only) |
| Langfuse/OTel | `src/instrument.ts` lines 107-115 | `registerTelemetry(LangfuseVercelAiSdkIntegration)` spans for AI SDK calls | `ai`, `@langfuse/*`, OTel | SKIP for MVP |
| Output logs API | `src/core/process/session-log.ts`; `src/api/logs/index.ts` (`GET /logs/:channel`); `packages/sandbox-sdk/src/client/logs.ts` | 4 fixed channels `dev, install, deploy, sandbox`, last `OUTPUT_LINES` entries | Hono, `readCommandLog` | REWRITE-USING-IDEA |
| Output panel UI | `apps/front/src/editor/bottomPanel/OutputTab.tsx`; `packages/components/src/Terminal/Terminal.tsx` (`anser`) | Channel list, refresh, 2 s poll, ANSI render | React, MobX runtime | SKIP (Reforma UI); UX idea only |
| Bash tool UI | `packages/components/src/chat/Tool/bash/BashTool.tsx` | Prompt line, stdout/stderr (red), exit/signal note, background badge | `@reforma/components` | SKIP |
| Desktop launcher | `apps/desktop/src/controller/launch.ts`: `controllerEnv`; `supervisor.ts`; `sandbox.ts`: `confine` | Env pick-list, kill ladder, orphan sweep, Seatbelt/bwrap confinement via `@anthropic-ai/sandbox-runtime` | Electron main, `sandbox-runtime` | REWRITE-USING-IDEA |
| CPU pinning | `core/process/cpu-quota.ts` | `taskset` to match a pod CPU quota | Linux cgroups | SKIP |

## 3. How a command runs (foreground path, verified)

1. `Bash.execute` handles `kill`, then poll-by-id, then requires `command` and `description` (both, else `exitCode:1` result).
2. `refuseHostMutation`, then `cwd = validatePath(input.cwd)` or `config.PROJECT_FOLDER`. `validatePath` (`src/core/files/path.ts`) allows project, project config, system folder, agent scratch, `/tmp`, plugins, deploy worktrees, global skill folders. It rechecks symlink targets, folds case on Windows, and uses a separator-safe prefix test.
3. `rewriteBashCommand` (rtk, 2 000 ms timeout; accepts exit 0 or 3; any miss/crash/timeout keeps the original).
4. `processRegistry.createCommand(spec, input.tool_call_id)`. Id is `cmd:` + 6 random chars unless the model supplied `tool_call_id` (the model supplies it, not the SDK). `spec.name = description.slice(0, 200)`.
5. `CommandRunner.start`: open JSONL (truncate), `getShellCommand`, `spawn`. Shell = `config.DEFAULT_SHELL` with `-c` on desktop and `-lc` hosted (a login shell resets PATH on a desktop; comment in `shell.ts`). `spec.shell:false` splits on whitespace, no quoting.
6. `spawn` re-validates cwd (skipped for `trusted` internal specs), `buildInvocation` builds env, `Bun.spawn` with piped stdin/stdout/stderr.
7. Every chunk: decode, `RingBuffer.push`, emit `output`, append one JSONL line.
8. Timer starts after spawn: default **120 000 ms**, max **600 000** (zod rejects more, no clamp). On expiry `kill('SIGKILL')` on the whole tree. Timed out here, not through `spec.timeoutMs`, so output so far is still returned.
9. Result: stdout and stderr rebuilt separately from ring entries by level (LOG/INFO vs ERROR/WARN), `keepTail` to `tailLines` (default **100**, max `OUTPUT_LINES` = **500**) with prefix `[truncated: last N of M lines]`, then `spillIfLarge` (**24 KiB**). Returns `{id, stdout, stderr, exitCode, durationMs}` plus `signal` and `log` path when it timed out, and a stderr line `Timed out after Xms and was killed. Full output is in log.`
10. A non-zero exit is a normal result, never a thrown tool error. Spawn failures return `exitCode:1` with `Process Error [CODE]: msg` or the plain message. The UI derives the failed state from `exitCode`.

Env hygiene: `safeBaseEnv()` = `PATH`, `HOME`, `TMPDIR/TMP/TEMP` (all set to `AGENT_TMP_DIR`) plus copies of `BASE_ENV_ALLOWLIST` from `process.env`: USER, LOGNAME, SHELL, LANG, LC_ALL, LC_CTYPE, TERM, TZ, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, NODE_USE_SYSTEM_CA, XDG_CONFIG/CACHE/DATA_HOME, BUN_INSTALL_CACHE_DIR, npm_config_cache, GIT_EXEC_PATH, GIT_TEMPLATE_DIR, GIT_CONFIG_SYSTEM. Provider keys, `SANDBOX_TOKEN` and the like are never copied (test `src/specs/core/bwrap.test.ts`). `{...safeBaseEnv(), ...spec.env}` when isolation is off (desktop). Because `Bun.spawn` gets the env object whole, children do not inherit anything else.

Output channels per command: ring buffer (RAM), JSONL file `LOG_DIR/<id with [^a-zA-Z0-9._-] replaced by _>.jsonl` (`cmd:ab12cd` becomes `cmd_ab12cd.jsonl`), WebSocket `output` events only when `connectEventBus` was called. Agent Bash never calls it, so **no live output** reaches the UI while an agent command runs.

## 4. Background commands, polling, delivery (verified)

| Step | Behaviour |
| --- | --- |
| Start | `background:true`. Needs a root chat thread: a subagent gets `Background tasks are not available in a subagent. Run in the foreground.` With no thread at all it still runs but nothing is registered. |
| Timeout | None unless `timeout` is passed; then `spec.timeoutMs` makes `CommandRunner` SIGKILL the tree. |
| Receipt | `{id, pid, status:'running', log}`; `log` is the JSONL path, readable with the Read tool because `LOG_DIR` is under `AGENT_TMP_DIR`. |
| Registration | `thread.registerBackgroundJob({id, description})` (in memory). `command.once('exit')` then `thread.enqueueBackgroundResult({id, output:{exitCode, signal, log}})`; `once('error')` enqueues `{error}`. A `delivered` flag guards double delivery. A failed `start()` enqueues the error too. |
| Poll | `Bash {id}` (no command, no kill): `{id, pid, status running/killed/exited, stdout, stderr, exitCode, signal, durationMs, log}` from the ring, or from the JSONL tail when the registry entry is gone. Unknown id: `exitCode:1`, `No command with id X.` |
| Kill | `Bash {kill:true, id}`: `command.kill()` (SIGTERM to the tree), then `await command.waitForExit()` with **no timeout and no escalation**. Reply always says `status:'killed'`. Passing `command` with `kill` is refused. |
| Delivery 1 (run active) | `takeStepNotes` (called from `RunContext` prepareStep, `src/chat/agent/helpers/runtime-context.ts:196`) takes unread finished jobs and adds a user-role text note `Background job <id> finished.` + `exit N` + `signal S` + stdout tail + stderr tail (100 lines each, spilled over 24 KiB). Id is `bg:` plus the job ids joined with a vertical bar. Stored once on the assistant message as an `AgentEventBuilder.backgroundResult` part. |
| Delivery 2 (explicit) | `GetBackgroundResult` tool returns the same unread list. |
| Delivery 3 (idle) | `enqueueBackgroundResult` fires `mailboxListeners`; `wakeForBackgroundResults` runs `runContinue` serialized per thread (`serialized()` chains a promise per thread and exits the run scope so a new run is not billed to the old one). Skipped when the last run was `cancelled` or a control takeover is pending. This starts a **new paid run** per wakeup. |
| Retention | Finished jobs stay on the thread until taken (`takeBackgroundResults`). Jobs and registry are in-memory; after a daemon restart only the JSONL on disk remains. |
| Stop from UI | `POST /threads/:threadId/background-jobs/stop` with optional `{ids}`; malformed `ids` is a 400, not "stop all". `stopBackgroundWork(id)` first (AbortController jobs), else `command.kill()` (SIGTERM), then drop from the session. |
| GC | Finished commands are removed from `processRegistry` about **1 s** after exit (`COMMAND_TTL_MS` default 0, GC interval 1 000 ms, or 60 000 ms when a TTL is set). Poll after that comes from disk and carries **no exitCode**; the exit code only reaches the model through the delivered result. `autoClean:false` (task-owned commands) is exempt. |

## 5. Killing, aborting, orphans

- `killProcessTree(rootPid, signal='SIGTERM')` (`spawn.ts:190`): POSIX snapshots descendants once, signals every descendant, then the root; returns signalled PIDs; `BunProcess.kill` falls back to `subprocess.kill` when it signalled none. Windows: `spawnSync('taskkill', ['/PID', pid, '/T', '/F'])`, always forceful whatever the signal; returns `[rootPid]` on status 0.
- Child discovery: Linux reads `/proc/*/stat` (regex on `pid (comm) state ppid`); macOS under Bun uses `proc_listchildpids` from `/usr/lib/libproc.dylib` through `bun:ffi` (buffer of 4 096 pids; chosen because the desktop Seatbelt sandbox refuses setuid `ps`); other cases use `ps -A -o pid=,ppid=`. `.briefback/docs/sandbox/shell.md` still says macOS uses `ps` (doc is behind the code).
- Why a walk and not a group kill: `Bun.spawn` children share the controller's process group (doc `shell.md`), so a group kill missed them. Test `src/specs/core/kill-process-tree.test.ts` covers bash plus background `sleep` on POSIX and is `skipIf(win32)`.
- Escalation exists only elsewhere: `TaskController.doStop` SIGTERM then 5 000 ms then SIGKILL; `PtyProcess.kill` SIGHUP then 3 000 ms then SIGKILL; `BunProcess.kill` lets a later SIGKILL through after a SIGTERM (`_killed` check). Bash `kill`, hooks (SIGTERM at 30 000 ms) and the UI stop do not escalate.
- Shutdown: `gracefulShutdown` in `src/index.ts` runs `processRegistry.cleanup()` (`killAll('SIGKILL')`, clear map), `terminalRegistry.cleanup()`, closes Sentry/Langfuse.
- Controller crash: hosted pods rely on bwrap `--die-with-parent` and a reaper (`tini -s`). Desktop supervisor (`apps/desktop/src/controller/supervisor.ts`) spawns the controller `detached` on POSIX, ladder: close stdin (10 000 ms), SIGTERM (5 000 ms), SIGKILL to the group; Windows closes stdin then `taskkill /T /F` only while the controller is alive (an exited pid may be reused). Then a sweep kills any process whose environment carries the project's `TMPDIR` (`/proc` on Linux, `ps -E` on macOS; Windows has no readable env, so it matches by executable path through PowerShell `Get-CimInstance Win32_Process`, async because PowerShell takes 1-2 s to start).
- `spawned-pid-registry.ts` covers only `trusted` spawns (dev server, install tasks). It checks liveness with `process.kill(pid, 0)`, with no start-time check, so a recycled pid could be killed.
- Agent abort: `ThreadSession.cancelRun` aborts the run's `AbortController` and marks the run `cancelled`. **Bash never reads `options.abortSignal`** (grep over `Bash.ts`: no reference). A foreground command keeps running after Stop until it exits or hits its timeout. Background commands deliberately outlive the run and are stopped by the jobs endpoint. Subagent children are cancelled through `cancelRun` in `child-profile.ts` / `subagents/run.ts`.

## 6. Permissions, secrets, stdin

- **No allow-list, no per-command approval for Bash.** `needsApproval` exists only on InstallPlugin and McpAuth. Controls are: the `refuseHostMutation` regex, the cwd path allow-list, tool-set membership per profile (read-only subagent profile has no Bash at `chat/agent/subagents/child-profile.ts:41`), the PreToolUse hook system (`src/chat/agent/hooks/*`, Claude-compatible, alias `Bash` to `Shell`; area of another note), and OS confinement. `local-projects.md` states that on Windows and wherever the sandbox is off the agent runs unconfined and commands need no approval.
- Redaction `redact()` in `logger.ts`: replaces the controller's own secrets (`API_KEY`, `LLM_API_KEY`, `UNSPLASH_ACCESS_KEY`, `SANDBOX_TOKEN`, `LANGFUSE_SECRET_KEY`; only values of 8+ chars) with `***`, plus patterns: JWT `eyJ...`, `Bearer <token>`, `://user:pass@`, `ghp_/gho_/ghs_/ghu_/github_pat_`. Applied to the `sandbox.jsonl` channel, Sentry messages, exception values, extras, contexts, breadcrumbs. **Not applied to command output** that goes to the model or to command JSONL files.
- stdin: `spawn` defaults `stdin:'pipe'`. Agent commands never write or close it (`endStdin` is only used by hooks, which write JSON then end). A command that reads stdin (prompts, `cat`) waits until the 120 s timeout. No `CI=1`, `NO_COLOR`, or `GIT_TERMINAL_PROMPT=0` for agent commands (`GIT_TERMINAL_PROMPT=0` exists only in `src/core/git/git-env.ts`; `NO_COLOR` only in `core/deploy/vercel.ts`).
- ANSI: nothing strips escape codes on the way to the model (grep: only `terminal-runner.ts` touches them). The UI renders them with `anser`. Pipes make most tools drop colour, but not all.

## 7. PTY terminals (interactive, not the agent)

`TerminalRunner` runs `node pty-host.cjs <cols> <rows> -- <shell>` through `spawnPty` (so under bwrap the PTY opens inside the namespace). Framing on the host's stdin: `type(1) length(4 BE) payload`, type 0 input, type 1 resize `cols(2) rows(2)`; exit code is the shell's, or `128+signal`. A headless `@xterm/headless` terminal (scrollback **5 000**) mirrors output, so `snapshot()` serialises the exact screen (modes for mouse and cursor are tracked and re-appended) for a client that attaches later. Limits (`config.ts`): 10 terminals total, 5 per user, exited TTL 10 min, detached TTL 12 h, heartbeat 5 min, output queue 1 MiB. `node-pty` is used because `Bun.Terminal` does not become the controlling terminal (bun issue 33237, per the file header). Shell is `[DEFAULT_SHELL]` on desktop, `[DEFAULT_SHELL, '-l']` hosted, env `TERM=xterm-256color`, `COLORTERM=truecolor`. Native packaging: node-pty prebuilds and `spawn-helper` must ship next to the script.

## 8. Logging

| What | Where | Format / limits |
| --- | --- | --- |
| Console | stdout/stderr of the controller | `console.debug/info/warn/error(prefix, ...)`, prefix `[Name]`. `LOG_LEVEL` default `info`; `debug` prints only at `debug`; `info` only at `debug` or `info`; `warn/error` always. |
| Sandbox channel | `LOG_DIR/sandbox.jsonl` (`LOG_DIR` = `AGENT_TMP_DIR/logs`) | One JSON object per line `{timestamp, source:'sandbox', level, message}`; `message` = `HH:MM:SS LEVEL [Name] util.format(args)` after `redact`. Written for info (when enabled), warn, error. Append mode; on open with a non-empty file writes `--- Sandbox restarted ---`. Stream error disables the channel silently. |
| Per-command log | `LOG_DIR/<id>.jsonl`, or `<logFile>.jsonl` for named channels (`dev`, `install`, `deploy`) | Entry `{timestamp:number, source:<runner id>, level, message:<raw chunk>}`; stdout = `LOG`, stderr = `ERROR` (the shared `ProcessOutputEntry` type also allows INFO/WARN, used by the sandbox channel). Truncated at start unless `appendLog` (install appends with a `--- <name> ---` separator). |
| Deploy failure | `deploy.jsonl` via `writeDeployFailLog` | Latest publish only. |
| Spill files | `AGENT_TMP_DIR/tool-output/<uuid>.txt` | Large tool results; never cleaned by the controller. |
| Agent-facing doc | `packages/reforma-system/rules/agent-scope.md` | Tells the agent that logs live in `/tmp/reforma/logs/` and to read them when an error is unclear. |
| Desktop files | `app.getPath('logs')/main.log` (`~/Library/Logs/Reforma` on macOS), `<userData>/scratch/<id>/logs/controller.log`, `<userData>/scratch/<id>/tmp/logs/*.jsonl` | Each holds only the last launch/start; nothing is uploaded; `prepareProject` deletes `tmp` on next start. |

Reading: `readCommandLog` seeks from the end in **64 KiB** blocks until it has `maxLines + 1` newlines, parses lines newest to oldest, drops malformed/partial lines, returns `{entries, found}`. Note `maxLines` counts JSONL entries (output chunks), not text lines.

Correlation ids: command id (`cmd:xxxxxx`) is the log file name and `source` field; JSON entries carry no thread id or tool-call id. Console lines carry none either. Sentry events get `thread_id` and `run_id` from an `AsyncLocalStorage` run scope (`src/chat/agent/run/run-scope.ts`: `getRunScope`), `project_id`/`user.id` from the request context, plus tags `host`, `sandbox_id`, `source`, `shell_version`. The AI SDK telemetry session id in Langfuse is the thread id (per `error-reporting.md`). `x-litellm-*` headers (gateway tagging) are Reforma cloud only.

What the UI can show: Bash card (command, ANSI output, exit/signal, background badge, "Background task finished" for polls); running-jobs strip from the `chat-thread:<id>` sync snapshot (`backgroundJobs`) with stop; Output tab with channels Dev server/Install/Deploy/Sandbox (initial fetch of the last 500 entries, 2 s polling, dev channel live-tailed through the task WebSocket); Terminal tab (PTY). Nothing shows a per-run or per-agent log.

Error classification (decided at the call site, no central filter):

| Call | Effect | Use for |
| --- | --- | --- |
| `logger.error` | log + channel line | user-caused or expected: bad path, their command/build/install failing, aborts |
| `logger.critical` | same line + Sentry (`captureException` for the `Error` arg, else `captureMessage`; extras from object args) | our failures: infrastructure, our API calls, invariants |
| `captureSandboxError(error, {source, tags, extra, fingerprint, level})` | Sentry with explicit tags; marks the error as reported | special reports, e.g. `failRun` in `agent.ts:~300` with `stop_reason` and `thread_id/run_id/model` extras, fingerprint `['ReformaAgent', stopReason]` |
| `wasReportedToSentry` | walks `cause` up to 5 levels | rethrow with `{cause}` so one failure reports once |

Examples in process code: `BunProcess.readStream` logs `critical` only if not killed; `spawn` failure is `critical` only when the cwd exists (a missing cwd is the caller's); `CommandRunner.handleExit` logs exit 143/130/SIGTERM/SIGINT at info, other non-zero at warn with the stderr indented, zero at info. Unhandled errors: Sentry's own integrations (rejection mode `none`), then `index.ts` logs and exits through `flushSentry` (2 000 ms). Sentry init: `sampleRate 1`, `maxBreadcrumbs 100`, console breadcrumbs cut to 2 000 chars, `beforeSend` scrubs with `redact` + `replaceHomeDir`, no server name on desktop, DSN empty means everything is a no-op (`captureSandboxError` returns early). `SENTRY_DATA_COLLECTION` (`packages/constants/src/sentry.ts`) turns off user info, cookies, bodies, genAI inputs/outputs.

## 9. Verified defects and traps (fix or avoid when porting)

1. Bash ignores `abortSignal`: a foreground command survives Stop (section 5).
2. Kill is SIGTERM only and awaits exit without a timeout (`Bash.ts:204-207`); a process that traps SIGTERM hangs the tool call. Same for the UI stop and for hooks.
3. stdin stays an open pipe (section 6): interactive commands hang to timeout; give agent commands `stdin:'ignore'` or an empty closed stream.
4. `BunProcess.waitForExit` hard-codes `signal: null`, so `CommandRunner.handleExit` never takes the KILLED branch in production; killed commands show state EXITED with whatever exit code the runtime reports (code treats 143 and 130 as expected, so presumably 128+signal). The `status:'killed'` of poll is reached only in mocked tests. Not run.
5. `BunProcess` appends every chunk to `stdoutBuffer`/`stderrBuffer` forever (nobody reads them except `ProcessResult`); a long-running chatty command grows memory without bound.
6. `new TextDecoder().decode(value)` per chunk with no `{stream:true}`: a multibyte character split between reads becomes U+FFFD. `PtyProcess` does it right.
7. `waitForExit` also awaits stream EOF, so a command that leaves a child holding stdout (for example `nohup server &`) keeps the foreground call blocked until the 120 s timeout kills the tree. Inferred from code, not run.
8. The doc comment on `CommandSpec.logFile` promises "bounded rolling segments"; no rotation or size cap exists (grep `rolling|rotate`). Command JSONL and `sandbox.jsonl` grow without limit. `resolveLogBasePath` guards with `startsWith(logDir)` without a separator (a sibling like `logs-evil` would pass).
9. The ring buffer and `tailLines` count chunks, then lines: a chunk can hold many lines, and a fast writer fills 500 chunks quickly, so the foreground result can omit the middle of long output (full text stays in the JSONL). stdout and stderr come back separately; interleaving exists only in the JSONL by timestamp.
10. `commandLogFiles` in the registry is never pruned. `createCommand(spec, id)` overwrites an existing entry when the model reuses a `tool_call_id`.
11. `BASE_ENV_ALLOWLIST` has no Windows variables (`SystemRoot`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`). The desktop launcher puts them in the controller's env (`launch.ts:controllerEnv`), but `safeBaseEnv()` copies only the allowlist, so agent children probably do not get them. Git Bash may mask this; check on Windows before relying on it.
12. `killProcessTree` takes one snapshot: processes forked after it escape. Tests skip Windows; `local-projects.md` says Mac and Windows were run by hand, `shell.md` says nothing was run on Windows, and no CI job runs Windows.
13. macOS `/bin/bash` is 3.2 (no bash 4 features) and `-c` does not read the user's profile, so Homebrew PATH is absent unless the launcher builds PATH, as Reforma's does with a bundled toolchain. A Clowdy daemon using the user's own tools needs `-lc`, or a PATH captured once from the user's login shell.
14. Log lines have no thread/run/tool-call id (only Sentry scope has). Per-task debugging in Clowdy will need ids on every line.
15. The reaper (`spawned-pid-registry`) records only trusted roots, so agent commands survive a daemon SIGKILL on desktop, apart from the supervisor's TMPDIR sweep.

## 10. Port plan

Under (a) (AI SDK loop kept):

- Port `Bash.ts` with: abort wiring (kill tree on `abortSignal`, then return the partial output), SIGKILL escalation after a grace period (suggest 5 s as in `TaskController`), `stdin:'ignore'`, ANSI strip for the model copy, `CI=1`/`GIT_TERMINAL_PROMPT=0`, Windows-safe env.
- Replace `resolveBackgroundThread`/`ThreadSession` with Clowdy's task/agent object; keep the three delivery paths (prepareStep note, explicit tool, idle wakeup) because they are what makes background work usable. Idle wakeup spends money: gate it per task setting.
- Keep id scheme `cmd:`; drop the model-supplied `tool_call_id` or use the SDK toolCallId and reject collisions.

Under (b) (engine owns the loop):

- Do not port `Bash.ts`/`GetBackgroundResult`/`step-notes`. The engine's own shell tool replaces them; check what its background/poll/kill semantics are (researched separately).
- Port the process layer for the daemon's own commands, plus: tail+spill helper (for outputs Clowdy relays), tree kill, ring buffer + JSONL log, PTY terminals for the UI, PID bookkeeping across daemon restarts, `rtk` only if Clowdy injects a shell tool via MCP.
- Reuse as logic: the `logger.error` vs `logger.critical` convention, `redact` patterns, report-once-by-cause, the supervisor stop ladder.

Runtime: `spawn.ts` is Bun-bound (`Bun.spawn`, `bun:ffi`, `import.meta.require`, `Timer`). `PtyProcess` and hooks already use `node:child_process`. For a Node daemon: use `child_process.spawn` with `detached:true` on POSIX (own process group, kill with `process.kill(-pid)`) and keep the descendant walk as backup for children that call `setsid` (Reforma notes Next's dev server does); Windows `taskkill /T /F`; macOS walk through `ps` (or `pgrep -P`) when unsandboxed.

Confinement: for macOS/Linux consider `@anthropic-ai/sandbox-runtime` as `apps/desktop/src/controller/sandbox.ts` uses it (Seatbelt / bubblewrap, denyRead of `/Users` etc. with allowRead of project folders, `allowPty`, network open). Reforma's own doc rules out a per-command sandbox inside it and finds no unelevated mechanism for Windows, so Windows runs unconfined there. Bubblewrap code in `bwrap.ts` is not portable.

## 11. Numbers

| Item | Value | Where |
| --- | --- | --- |
| Foreground timeout | default 120 000 ms, max 600 000 | `Bash.ts:18-19` |
| Background timeout | none unless passed | `Bash.ts:268` |
| Poll/foreground tail | default 100 lines, max 500 (`OUTPUT_LINES`) | `Bash.ts:20,159` |
| Ring buffer | 500 chunks | `config.ts:59`, `ring-buffer.ts` |
| Spill threshold | 24 KiB | `tool-result.ts:8` |
| Step note per stream | 100 lines | `step-notes.ts:10` |
| `description` stored as name | 200 chars | `Bash.ts:97` |
| rtk rewrite timeout | 2 000 ms | `rtk-rewrite.ts:3` |
| Registry GC | ~1 s after exit (TTL 0); 60 s tick if `COMMAND_TTL_MS` set | `process-registry.ts:25`, `config.ts:60` |
| API run default timeout | 300 000 ms (`DEFAULT_COMMAND_TIMEOUT_MS`), used by `POST /commands/run` and installs | `config.ts:159` |
| Hook timeout | 30 000 ms, SIGTERM | `hook-protocol.ts:17` |
| Task stop grace | 5 000 ms then SIGKILL; port wait 30 000 ms | `task-controller.ts`, `config.ts:160` |
| PTY kill grace | 3 000 ms (SIGHUP then SIGKILL) | `spawn.ts:542` |
| Terminals | 10 total, 5 per user, scrollback 5 000, exited TTL 10 min, detached TTL 12 h | `config.ts:62-71`, `terminal-runner.ts` |
| Orphan wait after kill | 500 ms, 15 ms poll | `spawned-pid-registry.ts:89` |
| Disk tail block | 64 KiB | `disk-log-store.ts:140` |
| Desktop stop ladder | stdin close 10 000 ms, SIGTERM 5 000 ms, SIGKILL; controller health 60 000 ms | `supervisor.ts:49-55` |
| Sentry | breadcrumbs 100, console line 2 000 chars, flush 2 000 ms, secret min length 8 | `instrument.ts`, `report-error.ts`, `logger.ts` |

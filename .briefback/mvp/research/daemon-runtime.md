# Daemon runtime and packaging

Research, 2026-11-17. Tested on macOS arm64 (Darwin 25.4) with Bun 1.4.4, Node 22.16, `@anthropic-ai/claude-agent-sdk` 0.3.325 (bundles Claude Code 2.1.325) and `@openai/codex-sdk` 0.169.0. **Nothing was run on Windows.** The experiment scripts are in `/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/fe81786a-671c-474f-b97c-3f5245a4e4fd/scratchpad/research/daemon-runtime/exp/`, a scratch folder that may be wiped. No prompt reached a model, so no quota was spent.

## Verdict

Run the daemon on **Bun**. On macOS every piece the daemon needs worked under Bun 1.4.4: bun:sqlite in WAL mode, `Bun.serve` serving SSE and WebSocket on 127.0.0.1, recursive `fs.watch`, process-group kill, and both agent SDKs. The Claude SDK completed its stdio handshake under Bun and saw the Max subscription. Both SDKs now start a **native binary**, so it no longer matters what runtime the daemon uses, and the SDK's `executable` option does nothing for us. For the MVP, run `bun apps/daemon/src/main.ts` from a pinned checkout. Later, ship the `bun build --compile` output (about 85 MB) with the agent binaries **beside it**, not embedded in it, and pass their paths explicitly.

## Key facts (measured unless marked)

1. **How the SDKs start agents.**
   - The Claude Agent SDK resolves `@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude[.exe]` with `createRequire(import.meta.url)` and runs it directly. On darwin-arm64 it is 347 MB. `executable` and `executableArgs` apply only when `pathToClaudeCodeExecutable` ends in `.js`, `.mjs`, `.ts`, `.tsx` or `.jsx` (see the `Qtt()` check in `sdk.mjs`).
   - The Codex SDK resolves `@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex`: 268 MB, plus `codex-code-mode-host` (67 MB), a bundled `rg` and 20 MB of voice resources. It runs `codex exec --experimental-json` once per turn through `node:child_process`, with no `detached`, no `windowsHide` and no spawn hook. `codexPathOverride` changes the binary path, but then the SDK stops adding the bundled `codex-path/` (which holds `rg`) to PATH, so the daemon has to add it itself.
   - Both SDKs import and resolve their binaries under Bun and under Node (exp 01).
   - I called `accountInfo()` and `supportedModels()` over a query whose prompt never yields, so nothing was sent to a model. Handshake times: Bun 206 ms, Node 198 ms, compiled Bun 225 ms. Every run reported `subscriptionType: "Claude Max"` and `apiKeySource: null` (exp 07). The bundled Codex 0.169 printed `Logged in using ChatGPT` for `codex login status`; it shares `~/.codex` with the user's own CLI.
   - **Environment.** An `env` passed to the Claude SDK replaces the child's environment; it is not merged. The SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` only when the variable is missing, and it always deletes `NODE_OPTIONS`. This session has 16 inherited `CLAUDE*` variables plus `ELECTRON_RUN_AS_NODE`, among them `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`. A daemon started from a Claude Code terminal passes all of them to every agent unless it builds the agent environment from an allowlist.
2. **bun:sqlite** (exp 02).
   - SQLite 3.51.0. On macOS Bun uses Apple's system library, where WAL is persistent, so the `-wal` and `-shm` files stay after close. On Windows and Linux Bun uses its own static build.
   - With WAL and `synchronous=NORMAL`: 100k event rows in one transaction took 152 ms, and 2,000 autocommit inserts took 49 ms.
   - A second process wrote 5,000 rows while the main process wrote 50,000. With `busy_timeout=5000` neither got `SQLITE_BUSY`, and a read-only reader in a third process ran without blocking.
   - Migrations keyed on `PRAGMA user_version`, applied inside `db.transaction(...).immediate()`, can be re-run safely.
   - `node:sqlite` also works in Bun and in Node 22, where Node still prints an experimental warning.
3. **Bun.serve** (exp 03).
   - Bound to `hostname: '127.0.0.1', port: 0`, the server refused connections on the LAN IP.
   - The default `idleTimeout` of 10 s **closes SSE streams that go quiet**. With it set to 2 s, the stream was reset at about 4 s and missed a later event. Calling `server.timeout(req, 0)` for each SSE request fixes this.
   - Replay from `Last-Event-ID`, backed by an events table cursor, worked.
   - WebSocket pub/sub (`ws.subscribe` and `server.publish`) worked. WebSocket connections have their own idle timeout, 120 s by default.
   - A foreign `Host` header got 421 (protection against DNS rebinding), and a missing bearer token got 401.
4. **Recursive `fs.watch`** (exp 04). It works on macOS in both Bun and Node and picks up newly created nested folders. Every event arrived as `rename`, including an append to an existing file, because FSEvents merges events; Node also reported the root folder once. Treat each event as "this path is dirty": debounce, then re-stat. Node/libuv support recursive watching on Windows (untested here). Bun 1.3.11 fixed a Windows crash when a failed watch was retried.
5. **Process trees** (exp 05, 08).
   - Killing a child started without `detached` left all 3 of its descendants running.
   - With `detached: true` (which calls setsid) and `process.kill(-pid)`, none survived.
   - A custom `spawnClaudeCodeProcess` with `detached: true` puts the `claude` CLI in its own process group. After SIGTERM to that group, the CLI exited cleanly in about 0.8 s.
   - When the daemon itself was SIGKILLed, all its children survived on macOS, detached or not. So the daemon must store each run's pid/pgid and clean them up on restart.
   - On Windows (untested), `taskkill /PID n /T /F` kills by parent pid and misses descendants whose parent already exited. Job Objects are the reliable fix, but they need native code.
6. **Memory per process.** An idle Claude Code process (initialized, no turn yet) used about 226 MB RSS. An idle `codex app-server` used about 74 MB. The Bun daemon skeleton used about 17 MB. **1,000 parallel Claude processes would need about 220 GB of RAM before doing any work.**
7. **`bun build --compile`** (exp 01, 06, 07).
   - The binary is 85–90 MB and builds in under 0.3 s.
   - Inside it, the SDKs cannot find their binaries: it fails with `Native CLI binary for darwin-arm64 not found` unless a `node_modules` folder happens to be reachable from the cwd. `process.platform` and `arch` are fixed at build time.
   - Passing `pathToClaudeCodeExecutable` and `codexPathOverride` that point at binaries shipped beside the daemon worked, handshake included.
   - Pointing at the user's own `claude` 2.1.322 also worked, although the SDK expects 2.1.325, so versions can drift.
   - The SDK also documents embedding the binary and calling `extractFromBunfs`, which unpacks 347 MB to `/tmp/claude-agent-sdk-<uid>` at startup.
   - **Trap:** in a compiled binary, `process.execPath` is the daemon itself. `spawn(process.execPath, ['-e', …])` started the daemon again, and that copy did the same, so I got a recursive chain of spawns. Use `BUN_BE_BUN=1` when you need the bun CLI.
8. **One daemon per data folder** (exp 06, 09).
   - A lock file created with O_EXCL, holding the pid and checked against a health endpoint, worked: 6 clients starting at once produced 1 daemon, and the next start recovered after the daemon was SIGKILLed.
   - SQLite gives a stronger lock: `locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE` on a separate small lock file. The kernel holds the lock and releases it on SIGKILL, so no stale-lock logic is needed (exp 09).
   - A plain Node client, standing in for Electron main, went from start to a healthy daemon in about 130 ms.
9. **Electron.**
   - The repo's fuse sets `runAsNode: false`. That rules out running the daemon on Electron's own Node through `ELECTRON_RUN_AS_NODE`, which is how Superset runs theirs.
   - `utilityProcess` is a child of the app, and its docs say nothing about outliving it, so it does not fit a daemon that must survive Quit. Use a detached spawn with `unref()`.
   - An app launched from Finder gets a minimal PATH. `bun` is not on it, and agents will not find the user's git or node toolchain unless the daemon resolves the login-shell PATH.

## How to use it (snippets that ran, trimmed)

**Paths.** Keep the daemon separate from Chromium's `userData`, and on Windows use Local AppData, not Roaming:
```ts
export function daemonRoot(): string {
  if (process.env.CLOWDY_DATA_DIR) return process.env.CLOWDY_DATA_DIR;           // second instance, tests, dogfooding
  const app = process.env.CLOWDY_PROFILE === 'dev' ? 'Clowdy Dev' : 'Clowdy';     // matches the desktop productName
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support', app, 'daemon');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), app, 'daemon');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'clowdy', 'daemon');
}
// <root>/instance.lock  SQLite file used only as a kernel lock
// <root>/daemon.json    {pid, port, token, version, protocol, startedAt}: mode 0600, written to tmp then renamed
// <root>/clowdy.sqlite  (+ -wal, -shm)   <root>/logs/   <root>/runs/<runId>/ (raw transcripts, stderr tail, artifacts)
// <root>/worktrees/<projectSlug>-<id4>/<runId8>/
```

**A single-instance lock the kernel releases on crash** (exp 09):
```ts
export function tryLock(path: string): Database | null {
  const db = new Database(path, { create: true });
  db.run('PRAGMA busy_timeout = 0'); db.run('PRAGMA locking_mode = EXCLUSIVE');
  try { db.run('BEGIN EXCLUSIVE'); return db; }                       // held until close or process death
  catch (e) { db.close(); if (/locked|busy/.test(String(e))) return null; throw e; }
}
// null → another daemon owns this root: read daemon.json, GET /v1/health with its token, print the port and exit 0.
```

**Loopback server with an SSE stream** (exp 03):
```ts
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, srv) {
  if (req.headers.get('host') !== `127.0.0.1:${srv.port}`) return new Response(null, { status: 421 });
  const cors = corsFor(req.headers.get('origin'));                   // allowlist: app://clowdy and the Vite dev origin
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!bearerOk(req)) return new Response(null, { status: 401, headers: cors });   // timingSafeEqual
  const url = new URL(req.url);
  if (url.pathname === '/v1/events') {
    srv.timeout(req, 0);                                             // otherwise Bun drops a quiet stream after 10 s
    const after = Number(req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0);
    return sseFrom(after, req.signal, cors);                        // rows with seq > after from SQLite, then live; ping every 15 s
  }
  return route(req, url, cors);                                      // POST commands carry a requestId (idempotency key)
} });
```
Use SSE for events and plain HTTP for commands. Chromium's `fetch()` can stream SSE and send an `Authorization` header; `EventSource` cannot send headers. Keep WebSocket for later, for example terminals.

**Starting agents in their own process group, and killing the tree** (exp 05, 08):
```ts
const spawnInOwnGroup = ({ command, args, cwd, env, signal }: SpawnOptions) =>
  spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
export function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch {}                // wait about 2 s, then SIGKILL the group
}
```

**Agent binaries and an environment allowlist** (exp 01, 07). In dev the SDKs resolve from `node_modules`; in a packaged app they come from the resources folder:
```ts
const exe = process.platform === 'win32' ? '.exe' : '';
const vendor = process.env.CLOWDY_AGENT_BIN_DIR;                     // set by Electron main for packaged builds only
const codexRoot = vendor && join(vendor, 'codex');                   // a copy of vendor/<triple>/
const agentEnv = pick(process.env, ['HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', /* win: */ 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']);
agentEnv.PATH = [codexRoot && join(codexRoot, 'codex-path'), loginShellPath()].filter(Boolean).join(delimiter);
agentEnv.CLAUDE_AGENT_SDK_CLIENT_APP = 'clowdy/0.0.1';               // never forward CLAUDE_*, CLAUDECODE, ELECTRON_RUN_AS_NODE, NODE_OPTIONS
query({ prompt, options: { cwd: worktree, env: agentEnv, spawnClaudeCodeProcess: spawnInOwnGroup,
  pathToClaudeCodeExecutable: config.claude?.executable ?? (vendor && join(vendor, `claude${exe}`)) } });
new Codex({ env: agentEnv, codexPathOverride: config.codex?.executable ?? (codexRoot && join(codexRoot, 'bin', `codex${exe}`)) });
```

**Electron main: find the daemon or start one** (exp 06; the client ran as plain Node):
```ts
export async function ensureDaemon(root: string): Promise<DaemonInfo> {
  const live = await probe(root);                                    // read daemon.json, GET /v1/health with its token, 800 ms timeout
  if (live) return live;                                             // reconnect: never start a second daemon on the same data
  const log = openSync(join(root, 'logs', 'daemon.out'), 'a');
  const [cmd, args] = app.isPackaged ? [join(process.resourcesPath, `clowdyd${exe}`), []] : ['bun', [join(repoRoot, 'apps/daemon/src/main.ts')]];
  spawn(cmd, [...args, '--data-dir', root], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: cleanEnv() }).unref();
  for (let i = 0; i < 50; i++) { await sleep(100); const info = await probe(root); if (info) return info; }
  throw new Error('Daemon did not start; see logs/daemon.out');
}
```
Main passes `{ baseUrl, token }` to the renderer through the preload. Closing the window leaves the daemon running. On Quit, ask whether to keep the daemon or stop it with `POST /v1/shutdown` (`drain` or `interrupt`). On Windows, signals cannot stop the daemon cleanly, because `process.kill` there is TerminateProcess.

**Daemon shutdown and restart reconciliation.** On SIGTERM, SIGINT or `/v1/shutdown`: `server.stop()`, mark active runs `interrupted` or let them finish, checkpoint WAL, close the DB, delete `daemon.json`. On start: find runs with status `running` from the previous process, kill their saved process groups (check the process start time to guard against pid reuse), set them to `interrupted`, run `git worktree unlock` on their worktrees, and only then accept clients.

## Where to keep worktrees

| Option | For | Against |
| --- | --- | --- |
| `<repo>/.clowdy/worktrees/` (Claude Code uses `.claude/worktrees/`) | Easy to find, same volume as the repo | Every project must gitignore it. tsc, eslint, vitest, IDE indexers, Vite/Turbo watchers and our docs watcher crawl N copies. Agents in the root checkout grep into them |
| Inside `.git/` | Hidden from tools | Not a supported layout; surprises backups and any tool that assumes `.git` holds only git's own data |
| Sibling folder `../<repo>.worktrees/` | Outside the tools' scope, same volume | Writes outside the folder the user chose; clutter and permission problems |
| **Clowdy-managed `<root>/worktrees/`** (the Codex app uses `$CODEX_HOME/worktrees`, configurable) | Never touches the repo; central cleanup and disk quota; the daemon owns the lifecycle | Can be on a different volume than the repo. Windows MAX_PATH (use short ids and `core.longpaths`). Time Machine and Spotlight pick up `node_modules`. Absolute `gitdir` links break if the repo moves (`git worktree repair`) |

Recommendation: a Clowdy-managed root that each project can override. Use `git worktree add -b clowdy/<run8> <path> <baseSha>` (or `--detach`, as Codex does), and record the base commit. Hold `git worktree lock --reason "clowdy run <id>"` while the run is active, as Claude Code does. Clean up with `git worktree remove` and then `prune`. Cap the number of worktrees kept; Codex keeps 15 by default. Git's own admin files stay in `<repo>/.git/worktrees/<name>` whatever the location.

## MVP recommendation and skeleton

1. Add `apps/daemon` on Bun, with no Electron imports. Keep Bun-only APIs in two files, `db.ts` (bun:sqlite) and `http.ts` (Bun.serve), so moving to Node later (`node:sqlite`, `node:http`) is a small job. The repo is already Bun-only.
2. **Dogfooding.** Never run the daemon you depend on with `--watch` from a checkout that agents change; a save would kill every running agent. Run the stable daemon from its own worktree (`git worktree add ../clowdy-stable main`) with the default data folder, and restart it by hand after an integration. A dev daemon started from any other checkout gets its own `CLOWDY_DATA_DIR`, so the two never compete for the lock.
3. Electron main gets `src/main/daemon.ts` (`ensureDaemon` above). The CSP in `src/main/protocol.ts` must allow `connect-src http://127.0.0.1:*`, and the daemon must answer CORS preflights for the `app://clowdy` origin and the dev origin.
4. Concurrency is a daemon setting: one global semaphore for agent processes (start around `min(16, RAM_GB / 0.5)`) and a queue for everything else. Fan-out beyond that comes from in-process subagents, not from extra processes.
5. Packaging, later: `bun build --compile --target=bun-<os>-<arch> --outfile clowdyd`. Put `clowdyd` and the agent binaries in electron-builder `extraResources`, outside the asar. Sign them with JIT entitlements: Bun's docs recommend five, and the repo's `entitlements.mac.plist` has two.

```
apps/daemon/src/
  main.ts       args/env → paths → tryLock → db.open + migrate → reconcile runs → Bun.serve → daemon.json → signals
  paths.ts      daemonRoot(), worktreesRoot(), logsDir()
  lock.ts       tryLock()
  db/index.ts   open(): WAL, synchronous=NORMAL, busy_timeout, foreign_keys; migrations.ts (user_version)
  events.ts     append(event) → events table (seq = cursor) + in-memory fan-out; sseFrom(after)
  http.ts       routes, Host/Origin/bearer checks, CORS, /v1/health, /v1/shutdown, /v1/events, commands
  proc.ts       spawnInOwnGroup, killTree, loginShellPath(), agentEnv()
  agents/       claude.ts, codex.ts: binary resolution plus the SDK adapters (see claude-agent-sdk.md, codex-sdk.md)
  git/worktrees.ts  add/lock/unlock/remove/prune
packages/protocol/  command, event and snapshot types; PROTOCOL_VERSION (also written to daemon.json)
```

## Limits and risks

- **Package size.** The Claude binary adds about 350 MB and Codex about 360 MB per architecture, plus 85 MB for the daemon; a universal macOS build doubles that. The alternatives are using the user's installed CLIs (they auto-update, so versions drift from the SDK) or downloading on first run.
- **RAM, not the daemon, limits parallelism** (fact 6). Subscription rate limits are covered in the other notes. SQLite and SSE will not be the bottleneck.
- **Orphans after a daemon crash**, and pid reuse when cleaning them up. Store `{pid, pgid, startTime}` for every run.
- **Windows, all unverified:**
  - `taskkill /T` has gaps.
  - The Codex SDK spawns without `windowsHide`, so a daemon with no console could flash console windows. Start the daemon with `windowsHide: true` rather than `--windows-hide-console`, so its children inherit a hidden console.
  - Signals cannot shut the daemon down.
  - MAX_PATH limits, antivirus scanning of worktrees, and Bun-on-Windows bugs (the 2026 changelogs still list watcher and socket fixes).
- **Security boundary.** The token in `daemon.json` (0600) plus Host and Origin checks keep out browsers and other machines, but any process running as the same user can drive the daemon. That is the same trust level as the user's own CLIs.
- **macOS GUI launches** need the login-shell PATH resolved (`$SHELL -ilc 'echo $PATH'`), or agents lose git, bun and node.
- `fs.watch` event types cannot be trusted (fact 4), so rescan after each event.

## Open questions

1. When the user quits, should the daemon keep running by default (spec 3.2 leaves it as a choice)? Does it need a menu-bar or tray presence while no window is open?
2. Should we bundle the agent binaries (control over versions, about 700 MB) or use the user's installed `claude` and `codex` (small, but versions drift)? A config override is needed either way.
3. Is the Clowdy-managed worktree root acceptable as the default, and should `node_modules` caches be shared across worktrees?
4. Protocol upgrades: when the app updates while an older daemon is still running, should Electron restart the daemon automatically once it is idle, or ask first?
5. When we package, does the compiled daemon need entitlements beyond `allow-jit` and `allow-unsigned-executable-memory`?
6. Can hundreds of CLI processes share one OAuth login without token-refresh races? The auth notes should confirm this.

## Sources

- Claude Agent SDK TypeScript reference (options, bundled binary, `bun build --compile`): https://code.claude.com/docs/en/agent-sdk/typescript
- The SDK's own README and `sdk.d.ts`/`sdk.mjs` in 0.3.325 (`X8()` binary resolution, the `Qtt()` runtime check, env handling)
- Codex SDK README (env, `codexPathOverride` in source): https://github.com/openai/codex/tree/main/sdk/typescript ; overview: https://learn.chatgpt.com/docs/codex-sdk
- Bun single-file executables (cross-compile, embedding, macOS codesign entitlements, `BUN_BE_BUN`): https://bun.com/docs/bundler/executables
- Bun SQLite (WAL, persistent WAL on macOS): https://bun.com/docs/runtime/sqlite
- Bun.serve `idleTimeout` and `server.timeout`: https://bun.com/docs/runtime/http/server ; WebSockets: https://bun.com/docs/runtime/http/websockets
- Bun child processes (`detached`, `unref`, PTY with ConPTY on Windows): https://bun.com/docs/runtime/child-process ; https://bun.com/reference/bun/Spawn
- Bun fs.watch guide: https://bun.com/docs/guides/read-file/watch ; Bun 1.3.11 Windows watcher fix: https://bun.com/blog/bun-v1.3.11
- Node fs.watch caveats: https://nodejs.org/api/fs.html#caveats
- Electron `app.getPath`: https://www.electronjs.org/docs/latest/api/app ; utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process
- A daemon that outlives an Electron app (Superset, ELECTRON_RUN_AS_NODE, persistence by default): https://paradev.com/cs/blog/terminal-daemon-deep-dive
- git worktree (admin dir, lock, prune, repair, relative paths): https://git-scm.com/docs/git-worktree
- Claude Code worktrees (`.claude/worktrees`, locks while running, `.worktreeinclude`): https://code.claude.com/docs/en/worktrees
- Codex app worktrees (`$CODEX_HOME/worktrees`, configurable root, keeps 15, detached HEAD): https://learn.chatgpt.com/docs/environments/git-worktrees

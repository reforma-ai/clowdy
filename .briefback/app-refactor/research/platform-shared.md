# Electron main process and the shared packages

## Summary

The Electron shell is hardened well and its code is careful. Context isolation, the sandbox, no Node and no webviews hold for both windows. Permissions are denied by default, navigation is locked to `app://clowdy`, and only `https:` opens outside. Fuses are set, the `app://` handler refuses traversal after `realpath`, and the OTA path verifies signatures, sizes and hashes. Every IPC payload is checked as `unknown`. I found no exploitable hole. Most of the problems are structural:

1. **The shell-to-daemon contract has no module of its own.** Main imports the `@clowdy/protocol` barrel, so zod and the whole `commandSchema` get bundled into main. The OTA gate (`SHELL_PATHS`) does not watch the routes, header and shapes that main depends on, so a daemon change to them can reach old shells through OTA.
2. **Client logic for `daemon.json` exists three times.** It is in main, in `apps/daemon/src/stop.ts` and in `scripts/dev.ts`, and only main validates what it reads.
3. **The IPC layer needs more manual steps than it should.** Each handler repeats the sender check, which is 14 copies. Errors cross the bridge wrapped, and only one renderer caller unwraps them. The `findInPage`/`stopFind` bridge is dead.
4. **`packages/lib` no longer matches the code that uses it.** About 540 lines are whole dead modules and dozens of exports are unused. Its `AGENTS.md` advertises helpers nobody uses, while the daemon, main and the file manager write their own `errorMessage`, `isRecord` and Windows file-name rules.
5. **HTTP request bodies are typed twice.** They are TS interfaces in protocol and zod schemas in the daemon, and enum literals are copied between the two.

Note for whoever plans this: any change under `SHELL_PATHS` (main, preload, shared, `protocol/src/paths.ts`, `constants/src/theme.ts`) holds back OTA bundles until a new shell version ships. Batch the main-process stages into one shell release.

## Findings

### F1. Shell↔daemon contract: barrel import bloats main, and the OTA gate does not watch it
- Where: `apps/desktop/src/main/index.ts:4`, `daemon.ts:3`, `daemonHost.ts:5`, `daemonProbe.ts:2`, `daemonKeeper.ts:4` (all `from '@clowdy/protocol'`); `packages/protocol/package.json` (`exports` has only `"."`); `packages/protocol/src/commands.ts:1,32` (zod schemas built at module load); `apps/desktop/scripts/publish-ota.ts:64-79` (`SHELL_PATHS`, `PROTOCOL_SOURCE`); `apps/desktop/src/main/daemonProbe.ts:24-58` (`parseDaemonInfo`, `parseHealth`).
- Problem (observed):
  - I bundled main to `/tmp` the way `buildMain` does. The result is 349 KB, and 18 of its modules are zod plus every protocol file (`agents`, `commands`, `domain`, `git`, `terminals`…). Main needs only `PROTOCOL_VERSION`, `PROTOCOL_HEADER`, `ROUTES.health`/`ROUTES.shutdown`, `daemonDataDir` and the `Health`/`DaemonInfo` types.
  - A bundle of the barrel is 197 KB and takes 10-16 ms to `require` in Node. Importing `api.ts` and `paths.ts` directly is 5 KB and 1.5 ms. That time is paid at every app start, before the window opens.
  - The contract main relies on lives in `api.ts`: the health and shutdown routes, the protocol header, the `Health` and `DaemonInfo` shapes, and the `?ifGitIdle=1`/409 behavior. `SHELL_PATHS` leaves `api.ts` out and compares only the `PROTOCOL_VERSION` number.
- Consequence (inferred): a bundle whose daemon renames a `Health` field, or changes the health or shutdown route, without bumping the protocol is published by `decideOta` to older shells. Their `parseHealth` then returns `undefined`, `findRunning` sees no daemon, and the shell starts a second one, which loses the lock.
- Fix:
  - Add `packages/protocol/src/shell.ts`, pure with no zod. Move into it `PROTOCOL_VERSION`, `PROTOCOL_HEADER`, `SHELL_ROUTES` (health, shutdown), `Health`, `DaemonInfo`, and `parseDaemonInfo`/`parseHealth` from `daemonProbe.ts`.
  - Re-export it from `api.ts` so other importers keep working, and add `"./shell"` to `exports`.
  - Main imports `@clowdy/protocol/shell` and `@clowdy/protocol/paths`.
  - Add `packages/protocol/src/shell.ts` to `SHELL_PATHS` and point `PROTOCOL_SOURCE` at it.
  - Optional: a Biome `noRestrictedImports` override for `apps/desktop/src/{main,preload,shared}/**` that forbids the `@clowdy/protocol` and `@clowdy/lib` roots.
- Category: perf / structure / correctness
- Effort: M. Risk: medium (shell release; the OTA gate changes).

### F2. Client logic for `daemon.json` is implemented three times, and only one copy validates
- Where: `apps/desktop/src/main/daemon.ts:72-80` with `daemonProbe.ts:24-43` and `daemonHost.ts:97-116` (validated, health-probed, sends the daemon's own protocol, honors 409); `apps/daemon/src/stop.ts:12-41` (`JSON.parse(...) as DaemonInfo`, sends this checkout's `PROTOCOL_VERSION`, ignores 409, waits for the file, 10 s); `apps/desktop/scripts/dev.ts:202-212` (`daemonRunning`: `as { pid: number }` and `process.kill(pid, 0)`, a second `processAlive`).
- Problem (observed): three readers of one file, with different validation and different stop semantics.
- Consequences:
  - `bun run --cwd apps/daemon stop` against a daemon of another protocol major sends the wrong header and is refused. The `apps/desktop/AGENTS.md` "Daemon" section documents this command as the manual way to stop a dev daemon.
  - A malformed `daemon.json` throws in `stop.ts` instead of printing a clean message.
- Fix: with F1 in place, `stop.ts` and `dev.ts` use `parseDaemonInfo` from `@clowdy/protocol/shell`. `stop.ts` sends `info.protocol`, as `daemonHost.stop` does, and handles 409 the same way. `dev.ts` uses the same parser plus a pid check. Keep the pid-liveness helper in one place: `daemonHost.processAlive`, or a tiny `@clowdy/lib/process` if the daemon needs it too.
- Category: reuse / correctness
- Effort: S. Risk: low.

### F3. Each IPC handler repeats the sender check, and nothing enforces it for new channels
- Where: `apps/desktop/src/main/ipc.ts:88-171` (14 copies of `assertTrustedSender(event, trustedOrigin)`, one `isTrustedSender` at 75); `apps/desktop/src/main/index.ts:113-115,522-524` (two hand-written broadcasts to every window); `apps/desktop/src/preload/index.ts:17-71` (14 `ipcRenderer.invoke` calls, an inline address guard at 20-28); `apps/desktop/src/shared/bridge.ts:137-139` (`{ url: string; token: string }` written twice, again in `renderer/daemon/config.ts:177`).
- Problem (observed):
  - The invariant "every IPC call is checked against the sender frame" (desktop `AGENTS.md`, Security invariants) holds only because each handler starts with the same line. A new channel that forgets it is open to subframes and to other origins, and only a hand-written test per channel would notice.
  - Adding one bridge method touches four places: `IPC_CHANNELS` plus the `DesktopBridge` type, the preload, the `ipc.ts` handler plus `IpcActions`, and the `index.ts` wiring.
  - `chooseDirectories`, `findInPage` and `stopFind` call Electron directly in `ipc.ts`, while the other channels are injected through `IpcActions`.
- Fix:
  - In `ipc.ts`, add `const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => { assertTrustedSender(event, trustedOrigin); return fn(event, ...args); })` and register every channel through it.
  - Add `broadcast(channel, payload)` for main→renderer sends.
  - In `shared/bridge.ts`, add `type DaemonAddress` and `parseDaemonAddress`, next to `parseUpdateStatus`, and use them in the preload and the renderer.
  - In the preload, add one `invoke(channel, ...args)` that also strips Electron's `Error invoking remote method '…': Error:` prefix (see F5).
- Category: safety / simplify
- Effort: S. Risk: low (shell release).

### F4. The `findInPage` and `stopFind` bridge is dead code that ships in every build
- Where: `apps/desktop/src/main/ipc.ts:162-171` (handlers) and `174-251` (`FIND_TIMEOUT_MS`, `FoundInPage`, `FindTarget`, `selectionArea`, `findOptions`, `findInPage`); `apps/desktop/src/shared/bridge.ts:21-24,104-124,152-155` (channels, `FindRect`, `FindResult`, `FindOptions`, bridge members); `apps/desktop/src/preload/index.ts:56-57`; `apps/desktop/src/main/ipc.test.ts` (find tests).
- Problem (observed): no renderer code calls them. The only renderer mentions are a stub in `theme.test.ts:52-58` and a comment in `shell/pageSearch.ts:3`, which says Chromium's `findInPage` "was dropped". `apps/desktop/AGENTS.md` says to "delete them with the next shell change". That is about 100 lines and two members of the preload surface, which the security model asks to keep minimal. `onFindCommand` stays: the Edit menu uses it.
- Fix: delete the two channels, their types, the preload members, the main code and their tests in the same shell release as F1 and F3.
- Category: dead-code / safety
- Effort: S. Risk: low (needs a shell release).

### F5. The renderer discards the reasons main writes for failed IPC calls
- Where: `apps/desktop/src/main/openWith.ts:234-253` and `openWithCatalog.ts:120-124` (readable reasons: "That path no longer exists", "A terminal opens a folder", "That app is not installed", "Windows Terminal cannot open a folder with a semicolon in its name"); `apps/desktop/src/renderer/features/openWith/openApps.ts:55-61` (catches everything and shows "Couldn't open it in X"); `apps/desktop/src/renderer/features/files/systemClipboard.ts:29-40` (the one place that unwraps Electron's prefix).
- Problem (observed): `DesktopBridge.openPath` is documented to "reject when the path is gone or the program cannot be started", and main writes reasons meant for people, but the person never sees them. The unwrapping lives in a single feature file instead of at the bridge.
- Fix: unwrap once in the preload (F3) and delete `unwrapped` and `asked` from `systemClipboard.ts`. `openPathIn` then shows `errorMessage(error)` as the toast's description under the existing title.
- Category: correctness / reuse
- Effort: S. Risk: low.

### F6. The external-link policy is written in five places, and terminal `http:` links do nothing
- Where: main `apps/desktop/src/main/security.ts:126-130` (`navigationDecision`: only `https:` goes outside, everything else is dropped silently); renderer `stream/markdown/components/Link.tsx:8-10` (`opensInBrowser`, its own copy of the rule), `features/settings/projects/projectView.ts:49`, `features/settings/providers/Account.tsx:70`; `features/terminal/TerminalView.ts:254-258` (Cmd/Ctrl+click calls `window.open(uri)` for any link xterm's WebLinksAddon finds, `http:` included).
- Problem:
  - Observed: the rule exists in main and is copied by hand in the renderer. The terminal path does not check it, so Cmd+clicking `http://localhost:5173`, the most common link a dev server prints, is denied by main with no feedback.
  - Observed: `lockNavigation` also drops a second link opened within one second, with no feedback.
  - Inferred: people will read this as a broken terminal.
- Fix:
  - Put `opensExternally(url)` in `apps/desktop/src/shared/bridge.ts`, or a sibling `shared/links.ts`. Main's `navigationDecision` and every renderer check use it, and the terminal skips or flags links it rejects.
  - Product decision: whether `http://localhost`, `127.0.0.1` and `[::1]` may open in the browser. If yes, change the one shared function.
- Category: correctness / reuse
- Effort: S. Risk: low (main side needs a shell release).

### F7. HTTP request bodies have two sources of truth, with literals copied by hand
- Where: protocol request types `packages/protocol/src/git.ts:379,482,498,504,513,543,647,695,743,774,802,826` (`GitViewedSet`, `GitCommitRequest`, `GitBranchMergeRequest`…) and `fs.ts:105`; daemon zod bodies `apps/daemon/src/http/routes.ts:79-180`, `http/fs-routes.ts:30-40`, `http/terminals.ts:32-38`.
- Problem (observed):
  - Commands follow the right pattern: `commandSchema` is zod in protocol, and `Command = z.infer<…>` (`commands.ts:447`).
  - HTTP bodies do not. The renderer compiles against the protocol interfaces, while the daemon validates against separately written zod objects, and nothing ties the two together (no `z.infer`, no `satisfies z.ZodType<…>`).
  - Literals are already copied by hand: `routes.ts:136` `z.enum(['from','into'])` copies `git.ts:684`, and `routes.ts:151` `expectedMode: z.enum(['up-to-date','fast-forward','merge-commit','squash','rebase'])` copies `GitBranchMergePreview['mode']` (`git.ts:713`).
  - The protocol type is not even the whole body. `GitBranchMergeRequest` leaves out `folderId` and `workspaceId`, which the daemon schema requires.
- Consequence (inferred): a field renamed on one side passes typecheck, and then the route answers `invalid` at runtime, or accepts a shape the client does not send.
- Fix: move each body schema into protocol next to its type, with the type derived as `z.infer`, as `commandSchema` does. Export the enum tuples (`GIT_MERGE_DIRECTIONS`, `GIT_MERGE_MODES`) and use them on both sides. At minimum, add `satisfies z.ZodType<GitCommitRequest>` in the daemon. Keep main off the barrel (F1), because this grows protocol's zod footprint.
- Category: structure / reuse
- Effort: M. Risk: low-medium (contract surface; no runtime change intended).

### F8. `packages/lib` is out of step with its users: dead modules, a misleading guide, two traps
- Where (consumers counted from every `import … from '@clowdy/lib…'` in `apps/`, `packages/`, `scripts/`; specs excluded):
  - Whole modules with no importer: `localstorage.ts` (139 lines), `async.ts` (101), `logger.ts` (66), `comparers.ts` (57), `values.ts` (57), `raf.ts` (56), `objects.ts` (36), `coords.ts` (14), `url.ts` (12). About 540 lines.
  - Mostly dead modules:
    - `date.ts`: only `calendarDayDiff` is used of 250 lines; `formatChatDayLabel`, `formatRelativeDate`, `formatDate`, `toDate` are unused.
    - `css-units.ts`: 12 of 24 exports unused.
    - `dom.ts`: `isElement`, `getRelativeCursorPos`, `getElementRects`, `isScrollable` unused.
    - `string.ts`: `humanizeString`, `indentBlock`, `indentText`, `leadingIndentLength`, `leadingWhitespaceLength`, `truncate` unused.
    - `path.ts`: `dirname`, `extname`, `pathSep`, `replaceHomeDir`, `resolveImportSpecifier`, `resolveRelativeImport` unused.
    - `files.ts`: `createObjectURL`, `revokeObjectURL`, `extensionForMediaType`, `mediaTypeForExtension` unused.
    - `math.ts`: `lerp`, `getPrecision`, `normalizeFloat`, `getRandomNumber` unused.
    - `errors.ts`: `readErrorMessage`, `errorCauseMessage` unused. `events.ts`: `dispatchEvent` unused.
  - `packages/lib/AGENTS.md` advertises `deepFreeze`, `leadingWhitespaceLength`, `isHttpUrl`, `createObjectURL` and `extensionForMediaType` as the house helpers, and none of them has a user.
- Problems (observed):
  - The guide sends agents to helpers the app does not use, while the app writes its own (F9).
  - `path.ts:48-52` `extname` is wrong: `/\.[^.]+$/` returns `.v2/file` for `dir.v2/file`. `dirname` returns `'.'` where the file manager's returns `''`.
  - `observers.ts` exports `makeObservable`, an event-emitter mixin with the same name as MobX's `makeObservable`, which the app uses everywhere. Auto-import can pick the wrong one. Its only user is `packages/components/src/Modal/Modal.ts:23`.
  - `clamp(min, value, max)` (`math.ts:8`) has the opposite argument order to the local `clamp(value, min, max)` in `packages/components/src/utils/colorValue.ts:214`, inside one package.
  - Also in protocol: `FsLocation` (`fs.ts:119`) has no user.
- Fix:
  - Delete the dead modules and exports, and the specs that only test them (`date.test.ts`, `url.test.ts`, `objects.test.ts`, parts of `css-units.test.ts`, `path.test.ts`).
  - Rename `makeObservable` to `makeEmitter`.
  - Use lib's `clamp` in `colorValue.ts`.
  - Rewrite `AGENTS.md` as a table of what is used.
  - Decision first: the owner may want to keep Reforma parity in lib so ports stay easy. If so, mark the parity-only modules as such in `AGENTS.md` instead of deleting them.
- Category: dead-code / docs
- Effort: M. Risk: low (decision needed on Reforma parity).

### F9. Helpers re-implemented in main, the daemon and the file manager despite lib
- Where:
  - `errorMessage`:
    - main: `ota.ts:35`, `index.ts:370`, `daemon.ts:210`, `daemonKeeper.ts:202`, `updater.ts:115,183`.
    - daemon: its own `apps/daemon/src/errors.ts:50`, plus inline copies at `providers/models.ts:101`, `providers/exec.ts:115`, `providers/login.ts:132,209`, `providers/codex/account.ts:207,215`, `providers/codex/models.ts:90`, `providers/cursor/account.ts:221`, `domain/workspaceSetup.ts:207`, `domain/workspaces.ts:213,1358`.
    - file manager: `documents/TextDocument.ts:83`, `search/TextSearch.ts:179`.
    - The renderer copies are in renderer-state F16 and ui-tasks-agents-panels.
  - `isRecord` and its variants: daemon `providers/cursor/models.ts:32`, `engine/acp/mapper-core.ts:21`, `engine/acp/permission.ts:31`, `engine/acp/registry.ts:627`, `git/pullRequestRollup.ts:14`; main `daemonProbe.ts:10`. lib has no `isRecord`.
  - `plural`: renderer `shared/time.ts:96`, `features/changes/changesStage.ts:26`, `features/settings/projects/projectView.ts:140`, while lib `string.ts:4` has it.
  - basename/dirname by `lastIndexOf('/')` in the renderer: `shell/CloneRepositoryForm.tsx:84`, `features/chats/mentionItems.tsx:32-33`, `features/files/openInFiles.ts:44`, `features/chats/fileReferences.ts:13`, `features/files/docsScope.ts:21`, `features/changes/gitSummary.ts:41`, `features/quickSearch/quickSearchSource.ts:20`, `features/agents/AgentList.tsx:595`. `@clowdy/file-manager/paths` and lib's `basename` already exist.
  - `humanize` (`renderer/stream/toolView.ts:41`) re-implements lib's `humanizeString`, which is unused. `renderer/shared/displayPath.ts` re-implements lib's `replaceHomeDir`, also unused.
  - Byte sizes: daemon `attachments/message.ts:2` `formatSize` (up to GB) against lib `formatFileSize` (up to MB) give two styles.
  - Media-type tables in four places: main `protocol.ts:27-45`, daemon `attachments/names.ts:~84`, daemon `domain/projectIcon.ts:9`, lib `files.ts:85` (unused).
- Problem (observed): the same small rules are written again and drift. lib's `errorMessage` falls back to `'Unknown error'` and trims, while every copy returns `String(error)`.
- Fix:
  - Main, the daemon (by subpath: `@clowdy/lib/errors`, which Biome allows) and the file manager (`@clowdy/lib/errors`, so its core does not pull React through the root) import `errorMessage`. Delete `apps/daemon/src/errors.ts:50`.
  - Add `isRecord` to a pure `@clowdy/lib/values` (replacing the dead content) and use it in the daemon, main and the renderer.
  - Point the renderer copies at lib's `plural` and `@clowdy/file-manager/paths`.
  - Pick one byte formatter and one media-type table. A pure `@clowdy/lib/files` can serve the daemon and main.
- Category: reuse
- Effort: M. Risk: low.

### F10. Windows file-name rules exist in five copies with different coverage, plus one comment/code mismatch
- Where: `apps/desktop/src/main/clipboardFiles.ts:87,108-114` (device names with an extension, case-insensitive, no superscript digits); `apps/daemon/src/attachments/names.ts:16-18` (superscripts and trailing spaces covered); `apps/daemon/src/domain/workspaces.ts:71` (no extension: `/^(con|…)$/`) with uses at `235,243-252,724`; `packages/protocol/src/domain.ts:361` (branch names, no extension); `packages/icons/scripts/sync-icons.js:148` (forbidden characters).
- Problem:
  - Observed: `workspaces.ts:70` documents "Names Windows does not allow for a folder, whatever the extension", but the regex has no extension part, so `folderSegment('aux.js')` and `folderSegment('nul.backup')` come back unchanged.
  - Observed: the copies disagree on case, superscript digits and trailing spaces.
  - Inferred: on Windows builds that still reserve `NAME.ext`, a worktree path segment made from such a folder name cannot be created.
- Fix: one pure module, `packages/lib/src/fileNames.ts` (the daemon imports it by subpath), exporting `WINDOWS_FORBIDDEN_CHARACTERS`, `isWindowsDeviceName(name)` (case-insensitive, any extension, trailing spaces, superscripts) and `isPlainFileName(name, platform)`. Use it in clipboardFiles, attachments, workspaces and the protocol branch rule. Protocol may import lib, or the module lives in protocol if lib must stay React-flavored.
- Category: reuse / correctness
- Effort: S-M. Risk: low.

### F11. The security-critical main-process code has no tests
- Where: `apps/desktop/src/main/security.ts:114-187` (`originOf`, `isTrustedUrl`, `lockNavigation`, the throttle of external opens, `restrictPermissions`, `windowOptions`); `security.test.ts` covers only `hasLaunchSwitches`. `protocol.test.ts:33-52` checks serving and hash refusal but no traversal.
- Problem (observed): the code is correct as I read it. `resolveFile` checks `path.relative` after `realpath`, and `decodePath` rejects malformed escapes. Still, a refactor of these functions (F3, F6) has no safety net for `/%2e%2e/x`, `/..%2fx`, `/%5c..%5cx`, a symlink out of the root, `%00`, `window.open('http://…')`, `javascript:`, `will-attach-webview`, or a permission request from a subframe.
- Fix: add table tests with fake `contents` and `session` objects (the functions already take `Pick<>`s) and a temp-dir symlink case in `protocol.test.ts`.
- Category: tests
- Effort: S. Risk: low.

### F12. `main/index.ts` mixes start-up, update UX and daemon orchestration in 591 untested lines
- Where: `apps/desktop/src/main/index.ts`: OTA wiring `181-221`; IPC wiring `237-256`; `daemonUp`/`daemonDown` `262-283`; `showSheet` `323-329`; `startUpdates` with the "Check for Updates…" decision flow over two updaters `336-435`; `daemonRuntime` `443-463`; `connectDaemon` `470-497`; `startKeeper` `509-546`; dev reload `549-566`; `openWindow` `568-591`. The `release` from `node:os` (line 2) is shadowed by `const release = releaseConfig(…)` (line 169) inside the `whenReady` callback.
- Problem (observed): `index.ts` has no test, yet `checkForUpdates` holds real branching (shell problem against OTA error against pending against up to date) and `connectDaemon` holds the keeper-outcome policy. The shadowed `release` is a trap for the next edit inside `whenReady`.
- Fix:
  - Extract `updates.ts` with `startUpdates`, `showSheet` and a pure `updateCheckOutcome(...)` that is easy to test.
  - Extract `daemonStartup.ts` with `daemonRuntime`, `connectDaemon`, `startKeeper`, `daemonUp` and `daemonDown`, taking `ota` and a `broadcast` (F3).
  - Rename the local to `releaseCfg` or import `os.release` as `osRelease`.
  - Leaves `index.ts` at about 200 lines of lifecycle.
- Category: structure / tests
- Effort: M. Risk: medium (start-up ordering; shell release).

### F13. `scripts/dev.ts` finds finished renderer builds by parsing Vite's console output and waiting for quiet
- Where: `apps/desktop/scripts/dev.ts:83-87` (`watch(rendererDir)` sets `lastWrite`), `90-131` (spawns Vite with `stdout: 'pipe'`), `214-226` (`echoBuilds`: `text.includes('built in')` on raw chunks), `228-231` (`landed()`: polls until 300 ms pass with no writes).
- Problem:
  - Inferred: the check depends on Vite's log wording, and on the phrase not being split across two stdout chunks.
  - Observed: on a slow disk, or with a large write pause, `landed()` can let a reload in before the files are complete, or delay every reload by 300 ms or more.
- Fix: a small Vite plugin in `vite.config.ts`, enabled by an env flag that `dev.ts` sets, writes `DEV_BUILD_MARKER` in its `writeBundle` or `closeBundle` hook, which runs after the files are on disk. `dev.ts` then drops `echoBuilds`, `landed`, `lastWrite` and the directory watch, and can inherit Vite's stdout.
- Category: simplify / correctness
- Effort: S. Risk: low (dev only).

### F14. The screenshot harness copies the window chrome and skips the app's origin and CSP
- Where: `apps/desktop/scripts/shoot-main.cjs:33-39` (hard-coded `height: 44`, `trafficLightPosition: { x: 17, y: 15 }`, colors) against `apps/desktop/src/main/security.ts:5-67` (`TITLE_BAR_HEIGHT`, `windowChrome`); the harness loads the Vite dev-server URL (`screenshot.ts`), so no `app://` handler and no `CONTENT_SECURITY_POLICY` (`protocol.ts:7-25`) applies.
- Problem:
  - Observed: a change to the title band or the traffic lights has to be copied by hand.
  - Inferred: "Checking the UI without a person" cannot catch a CSP regression, such as a new inline script, a remote image or a disallowed `connect-src`. Those break only in the real app.
- Fix: write `shoot-main` in TS and bundle it with `buildMain`'s Bun step. It imports `windowChrome`, and gets an `--app` mode that registers `appScheme` and `createProtocolHandler(dist/renderer)` and loads `app://clowdy/?fixtures…`, so screenshots run under the real origin and CSP.
- Category: tests / reuse
- Effort: M. Risk: low (tooling).

### F15. Copy and doc drift in the shell's own text
- Where:
  - Single-sentence dialog text that ends with a period, against the root `AGENTS.md` copy rule: `apps/desktop/src/main/daemonDialog.ts:8` "Clowdy cannot start its daemon."; `daemon.ts:85-86` (both message and detail), `146` "The daemon exited with code N.", `175` "…did not stop within N seconds.", `183-184` "Daemon is not bundled in this build." and its detail.
  - `apps/desktop/AGENTS.md` "Packaged app" says the daemon bundle is `main.js` and `mcp-stdio.js`. `apps/daemon/scripts/bundle.ts:2-17` also builds `clowdy.js`.
  - `packages/protocol/src/events.ts:74` says `ProjectSnapshot` is "Events for a project plus the docs tree", but the type has no docs field.
- Problem (observed): the sheets show text that breaks the copy rule, and agents read a stale bundle layout.
- Fix: drop the periods. Fix the two docs.
- Category: docs
- Effort: S. Risk: low (the dialog strings need a shell release).

### F16. Bundle metadata is parsed twice with different strictness
- Where: `apps/desktop/src/main/bundle.ts:8-38` (`BundleInfo`, `parseBundleInfo`: accepts any `minShell` string) and `bundleManifest.ts:9-19,62-84` (`BundleManifest` repeats `version`, `minShell` and `protocol`, and requires `minShell` to match `^\d+\.\d+\.\d+$`). `scripts/bundle.ts:92` builds a manifest as `{ ...info, archive, files }`.
- Problem (observed): two interfaces and two validators for the same three fields. The app's own `bundle.json` accepts a `minShell` the manifest would refuse.
- Fix: `interface BundleManifest extends BundleInfo`, plus one `checkBundleInfo(value)` that both parsers call.
- Category: simplify
- Effort: S. Risk: low (shell release).

### F17. "Open with" rescans the app folders several times per action
- Where: `apps/desktop/src/main/openWith.ts:80-94` (`macApps` does `readdir` on 4 folders), called by `programs()` at `151` and `fileManagers()` at `176`. `listApps` (`221-230`) runs three of them in parallel, and each `openPath` call (`249-250`) rescans one more time.
- Problem (observed): opening the menu triggers 12 `readdir` calls on macOS where 4 would do, and every open rescans. On Windows `walk` globs the Program Files folders each time. The cost is small, but it is on a user click.
- Fix: compute `macApps()` once per `listApps` call and pass it in. Keep the last `Found[]` from `listApps` for `openPath`, rescanning only when the id is missing, since a program can be installed while the app runs.
- Category: perf
- Effort: S. Risk: low (shell release).

### F18. The packaged app's View menu includes Toggle Developer Tools
- Where: `apps/desktop/src/main/menu.ts:100`.
- Problem: the renderer holds the daemon token. Through `/v1/terminals` and the fs routes, that token is equivalent to shell access, which `clipboardFiles.ts:37` says too. DevTools gives anyone at the unlocked keyboard a console with that power, and a scripted path to it. This is the same user account, so the risk is low, but it sits awkwardly beside the refusal of `--remote-debugging-port` (`security.ts:192-201`).
- Fix: include `toggleDevTools` only when `!app.isPackaged`, or hide it behind a setting.
- Category: safety
- Effort: S. Risk: low (support loses an easy console; product decision).

## Cross-area notes

- **OTA coupling (for the planner):** every change under `SHELL_PATHS` (`publish-ota.ts:64-77`) stops OTA publishing until `apps/desktop/package.json` gets a new version. F1, F3, F4, F5 (preload part), F6 (main part), F11, F12, F15, F16 and F17 all touch it. Group them into one shell-release stage.
- **packages/protocol:**
  - Add `src/shell.ts` and an `exports` subpath (F1).
  - Move the HTTP body schemas in and derive their types (F7).
  - Export the enum tuples used by daemon routes (`GIT_MERGE_DIRECTIONS`, `GIT_MERGE_MODES`).
  - The renderer's `features/openWith/openTarget.ts:24` declares its own `FolderGit`, which has a different shape from protocol's `FolderGit`. Rename it, for example `OpenTargetGit`.
- **packages/lib:**
  - Add a pure `isRecord` (F9; renderer-state wants it too).
  - Add `fileNames.ts` (F10).
  - Prune dead code (F8).
  - The lib root re-exports `react.ts` and `hooks.ts`, so any consumer of `@clowdy/lib` loads React. The file-manager core's Biome rule forbids `react` but allows the `@clowdy/lib` root, which leaks React in transitively. Today no core file imports lib, but the rule could forbid the root there, as the daemon's override already does.
- **Renderer (already covered elsewhere):** the fixture daemon is statically bundled into production (`renderer/daemon/config.ts:3-15`, renderer-state F6), and the renderer has its own `errorMessage` and `isRecord` copies (renderer-state F16, ui-tasks-agents-panels).
- **Renderer bridge access:** `window.desktop?.…` is read directly in 18 renderer files, and `window.desktop?.chooseDirectories` is repeated in 6 (`shell/CloneRepositoryForm.tsx:115`, `shell/FolderList.tsx:158`, `features/agents/ProjectMenu.tsx:34`, `features/settings/projects/projectActions.ts:240`, `features/openWith/useFolderRepair.ts:21`, `features/settings/projects/ProjectFolders.tsx:155`). A small `renderer/desktop.ts` facade with `chooseFolders()`, `canOpenPaths()` and similar would be the single place that handles a missing bridge and unwraps errors (F5).
- **Daemon:**
  - `stop.ts` should use the shared parser and send the daemon's own protocol (F2).
  - `errors.ts:50` duplicates lib (F9).
  - The comment and regex disagree in `domain/workspaces.ts:71` (F10).
- **Contract note:** the renderer casts daemon responses (`httpTransport.ts:228,524,599,677-700,736`) without validating them. That is acceptable because the renderer and daemon ship in one bundle, but the keeper deliberately keeps a newer daemon of the same protocol major (`daemonKeeper.ts:63-77`). Keep protocol changes within a major additive-only, and say so in `api.ts` next to `PROTOCOL_VERSION`.
- **CSP:** `connect-src … http://127.0.0.1:* ws://127.0.0.1:*` (`protocol.ts:16`) allows any loopback port, so an XSS in the renderer could reach any local service. Pinning the port is impossible as long as the daemon can move without a page reload (`onDaemonChange`), so this is an accepted trade-off. It is worth stating in the Security invariants section.

## Not inspected / limits

- I did not run the app, the test suites or a packaged build. I did build main to `/tmp` with `bun build` to measure its contents, and timed `require` of two small protocol bundles in Node.
- I did not measure the size of an installed OTA bundle. `ota.choose()` hashes every file of the chosen bundle before the window opens (`ota.ts:421-448`), and the protocol handler hashes each renderer file again on every request (`protocol.ts:61-64`). Measure this on a real bundle before deciding whether to cache verification per file.
- The Windows-only paths (Mica, `wt.exe`, Explorer, `%LOCALAPPDATA%` discovery, ConPTY) were read, not run. `openWithCatalog.ts` says so itself.
- `scripts/licenses.ts` (591 lines) and `packages/system-skills/scripts/validate.ts` were skimmed for structure only. They are self-contained and looked fine.
- On macOS, the file manager's `shell.openPath` on a folder (`openWith.ts:257-266`) opens package-type folders other than `.app` (`.pkg` bundles, `.prefPane`) in their handler instead of revealing them. This is low risk because each handler prompts, and I did not verify it.
- I did not review the daemon's own auth for the terminal WebSocket or the SSE feed. The daemon research covers it.

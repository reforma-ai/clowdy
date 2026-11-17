# Clowdy Desktop (`@clowdy/desktop`)

The Electron app: main process, preload, and the React + Vite renderer. For now it opens an empty window; the daemon (spec §5) and the workspace UI grow from here. Run commands from the repository root with `./clowdy`, or from this folder with Bun.

## Layout

```
src/main/        Main process: window, menu, security, app:// protocol, IPC
src/preload/     The bridge exposed as `window.desktop`
src/shared/      Contract between main, preload, and renderer (bridge type, IPC channel names)
src/renderer/    React app (index.html, main.tsx), served by Vite
scripts/         dev.ts, build.ts, main-bundle.ts
vite.config.ts   Renderer build and dev server
electron-builder.ts, build/   Packaging config, icon, macOS entitlements
```

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Builds the workspace packages (Turbo), starts the Vite dev server for the renderer, bundles main and preload, and starts Electron on it. Renderer edits hot-replace; a change under `src/main`, `src/preload`, or `src/shared` restarts the app, and after a crash the next such save starts it again. Quitting the app ends the session. Arguments go to Electron. `CLOWDY_RENDERER_PORT` (default 5273) moves the dev server; a taken port stops the run with a message. |
| `bun run build:app` | Release build into `app/`: the renderer (`app/renderer`), main and preload (`app/dist`), and the packaged app's own `package.json`. |
| `bun run package` | `build:app`, then an unpacked `Clowdy.app` with an ad-hoc signature, which runs only on the Mac that built it: `release/mac-arm64/` on Apple silicon, `release/mac/` on Intel. Needs a Mac. |
| `bun run package:win` | `build:app`, then unpacked, unsigned apps in `release/win-unpacked/` (x64) and `release/win-arm64-unpacked/`. Works on any OS. |

## How it fits together

- **Dev:** the window loads `CLOWDY_RENDERER_URL` (the Vite server). A packaged app ignores it. The origin the window trusts for navigation, permissions, and IPC is that URL's origin in dev and `app://clowdy` when packaged.
- **Packaged:** `src/main/protocol.ts` serves `app/renderer` from `app://clowdy` with a CSP header. `app.getAppPath()` is the root of `app/`, so the preload is `dist/preload/index.cjs` and the renderer `renderer/`.
- **Window chrome:** `src/main/security.ts` (`windowChrome`) gives macOS `vibrancy: 'under-window'` and Windows 11 22H2+ Mica, with a 48px hidden title bar and a clear background. The preload reports the material to the page (`window.desktop.material`); `src/renderer/windowChrome.ts` mirrors the window controls onto `<html>` (`data-window-material`, `data-window-buttons-leading`), and `base.css` reads them for the drag region and the tinted body.
- **Theme:** `src/renderer/theme.ts` follows the system appearance (`.dark` on `<html>`), and so does the native material. `window.desktop.setThemeSource` sets `nativeTheme.themeSource` for a future appearance setting, so the material matches a forced light or dark page. On Windows main recolors the caption button symbols when the appearance changes.

## Security invariants

- The renderer is untrusted: context isolation, process sandbox, no Node, no webviews. Every permission is denied except clipboard writes from the app's own top-level page.
- Navigation stays on the trusted origin; `https:` links open in the system browser, at most one a second.
- Every IPC call is checked against the sender frame (`assertTrustedSender`). Keep the bridge minimal: domain logic goes through the daemon's versioned contract, not Electron IPC.
- A packaged app refuses to start with command-line switches (`-x`, and `/x` on Windows), and one instance runs at a time.
- Fuses in `electron-builder.ts` turn off `runAsNode`, `NODE_OPTIONS`, and inspect arguments, and require the app to load from the ASAR.

## Traps

- `Bun.build` inlines `__dirname` as the source directory. Build paths from `app.getAppPath()`.
- `URL.origin` is the string `"null"` for the custom `app:` scheme. Compare origins with `originOf` in `security.ts`.
- `ELECTRON_RUN_AS_NODE` (set by VS Code's extension host, for one) starts Electron as plain Node. `scripts/dev.ts` removes it; unset it yourself when launching a binary by hand.
- The renderer imports design system parts by subpath (`@clowdy/components/Text`), not the package barrel, which pulls in every component and its dependencies (TipTap, CodeMirror, Shiki).
- Windows paths break code written for POSIX ones: use `fileURLToPath`, not `new URL(...).pathname`.
- electron-builder needs an exact Electron version, so `electron` is pinned. Upgrade it on purpose.
- The app icon (`build/icon.png`) is a placeholder. There are no installers, signing, or notarization yet: `package` signs ad hoc and Windows builds are unsigned.
- One instance runs at a time, and dev runs share the `Clowdy Dev` user data folder and port 5273. A second `./clowdy dev` (another worktree, say) stops on the taken port; with `CLOWDY_RENDERER_PORT` set it gets past that, but its Electron finds the first one running and quits.
- `appId` (`app.clowdy.desktop`) and the `Clowdy` / `Clowdy Dev` user data folders follow the working name. Settle them before a first release: updates and stored data depend on them.

## Not verified

macOS (arm64) is built, launched, and checked in dev and packaged form. The Windows apps build, but nothing was run on Windows, so Mica and the caption-button overlay are untested there.

# Third-party notices: what ships, what exists, what a credits list needs

## Summary

Clowdy has no credits mechanism. What exists: one hand-written root file `THIRD-PARTY-LICENSES.md` with a single entry (Material Icon Theme), which is not packaged and not linked anywhere, plus license texts kept beside some vendored assets. No bundle keeps its dependencies' license comments (0 of 352 renderer chunks, and neither the main nor the daemon bundle, contain "Copyright" or "@license"), so the shipped JS carries no notices of its own. Electron's own `LICENSE.electron.txt` and `LICENSES.chromium.html` (5.6 MB) are shipped by electron-builder.

What actually ships, measured by bundling the current tree into the scratchpad (exact module lists, not a guess from `package.json`): 251 distinct npm packages (name@version), all permissive (MIT, Apache-2.0, ISC, BSD-2-Clause, BlueOak-1.0.0 as declared in their `package.json`). No GPL, LGPL, MPL, CC, or unlicensed npm package ships. The non-MIT items that matter for the text of the credits are the Onest font (SIL OFL 1.1), the Bun runtime (MIT, with LGPL-2 JavaScriptCore linked statically), Electron and Chromium, and nine Apache-2.0 packages. Four packages ship no license file.

## What ships in the packaged app

| Part | What | Third-party content |
| --- | --- | --- |
| Renderer (`app/renderer`, ASAR; the OTA bundle's `renderer/`) | `vite build` of `src/renderer` | 3,921 modules, 232 npm packages, 352 JS chunks (about 15 MB, Shiki grammars are most of it), 1,253 Material Icon Theme SVGs (about 1 MB), 3 Onest `.woff2` files (62 KB), 20 MB on disk |
| Main and preload (`app/dist`) | `Bun.build` in `scripts/main-bundle.ts`, everything inlined (`files: ['!node_modules/**']`) | `index.cjs` 885 KB: 20 npm packages (electron-updater and its closure, minimatch, zod) |
| Daemon (`Resources/bundle/daemon`, OTA `daemon/`) | `Bun.build` in `apps/daemon/scripts/bundle.ts`: `main.js` 1.5 MB, `mcp-stdio.js`, `clowdy.js` | 4 npm packages: `@agentclientprotocol/sdk` (Apache-2.0), `zod`, `@xterm/headless`, `@xterm/addon-serialize` (MIT). The agent adapters (`@agentclientprotocol/claude-agent-acp`, `codex-acp`) are not shipped: the daemon fetches them on first use with `bun x --bun` (`src/engine/acp/catalog.ts`, `Launch`) |
| System skills (`packages/system-skills`) | Markdown skills, 192 KB | Nothing third-party found (grep for licence or attribution text) |
| Bun (`Resources/bun/bun`, `bun.exe`) | Downloaded from `oven-sh/bun` at the pinned version, hash-checked (`scripts/bun-runtime.ts`) | Only the executable and a `VERSION` file are laid out |
| ripgrep (`Resources/bun/rg`) | BurntSushi's release build (`scripts/ripgrep.ts`) | The archive's `COPYING`, `LICENSE-MIT`, `UNLICENSE` are kept beside it as `ripgrep-*` |
| Electron and Chromium | The Electron distribution | `LICENSE.electron.txt` (MIT, 1 KB) and `LICENSES.chromium.html` (5.6 MB) at `Contents/Resources/` on macOS and beside `Clowdy.exe` on Windows (seen in the older builds in `apps/desktop/release/`) |

The renderer's own code includes forks of Reforma: `packages/components`, `packages/styles`, `packages/file-manager` (`license: UNLICENSED`), the icon packs from Reforma's Figma, and the Loader animation `packages/components/src/Loader/reforma-loader.json` (bundled; AGENTS says it is Reforma's mark until Clowdy has its own).

## What exists today

- `THIRD-PARTY-LICENSES.md` (root, committed in `28f576d3`): one section, Material Icon Theme 5.40.0, MIT, "Copyright (c) 2025 Material Extensions", full text. Not in electron-builder's `files`, not read by any script, not mentioned in README or AGENTS. A copy exists in an old agent worktree under `.claude/worktrees/` (ignore it).
- `packages/styles/src/assets/fonts/Onest/OFL.txt` — "Copyright 2021 The Onest Project Authors (https://github.com/googlefonts/onest)", SIL OFL 1.1, no reserved font name line seen. Vite copies the `.woff2` files only, so the packaged app does not carry the text.
- `packages/icons/src/assets/SOURCES.md`, `LICENSE-browser-logos.txt`, `LICENSE-supertinyicons.txt` — MIT texts for the browser and OS logos (alrra/browser-logos, edent/SuperTinyIcons). The renderer bundle imports only `ProgressLoader` from that pack, so those logos do not ship today.
- `packages/icons/src/logo/SOURCES.md` — brand marks; documents only `claude..svg`, `openai.svg` (Simple Icons paths) and `cursor.svg` (Cursor brand kit). Four marks are in the renderer bundle: Claude, Cursor, OpenAI, GitHub. The sources of the other marks in that folder are not documented; "Logos and trademarks belong to their respective owners" is the only notice.
- `packages/eslint-config/LICENSE` — "MIT, Copyright (c) 2026 Reforma, Inc."; a dev tool, not shipped.
- No `LICENSE`, `NOTICE`, `CREDITS`, or "licenses" script at the repo root or in `apps/desktop`. Clowdy's own license is not stated; every `@clowdy/*` package is `private`, and `@clowdy/file-manager` says `UNLICENSED`.
- `electron-builder.ts` has no license option (`nsis` is one-click, so there is no EULA screen).

## License census (declared in each package's `package.json`)

Counts come from the module lists of three real bundler runs; unique name@version across them is 251 (`marked` and `redux` appear in two versions each).

| Bundle | Packages | MIT | Apache-2.0 | BlueOak-1.0.0 | ISC | BSD-2-Clause |
| --- | --- | --- | --- | --- | --- | --- |
| Renderer | 232 | 221 | 8 | 1 (minimatch) | 1 (`@ungap/structured-clone`) | 1 (`entities`) |
| Main and preload | 20 | 16 | 0 | 3 (minimatch, graceful-fs, sax) | 1 | 0 |
| Daemon | 4 | 3 | 1 (`@agentclientprotocol/sdk`) | 0 | 0 | 0 |

- Apache-2.0 (9 packages across bundles): `react-aria`, `react-stately`, `react-aria-components`, `@internationalized/string`, `@internationalized/number` (Adobe), `streamdown`, `remend`, `@sanity/diff-match-patch`, and the daemon's `@agentclientprotocol/sdk`. None ships a `NOTICE` file.
- 247 of 251 packages have a license file in the installed package. Four do not: `react-arborist@3.16.0` (declares MIT), `lazy-val@1.0.5`, `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`. Their text and copyright line must come from a fallback (the SPDX template and the `package.json` author or repository field, or a committed override).
- 21 distinct license texts once copyright lines are ignored. Raw license text of all 247 files: 348 KB; with each distinct text kept once: 46 KB, plus about 12.5 KB of copyright lines.
- A walk of `package.json` `dependencies` from `apps/desktop` gives 300 third-party packages (a superset: includes workspace packages' declared dependencies) and adds two that are not in any bundle: `chroma-js@3.3.0` (BSD-3-Clause AND Apache-2.0; a dependency of `material-icon-theme`, which the app uses only for its JSON manifest and SVGs) and `argparse@2.0.1` (Python-2.0; used by `js-yaml`'s CLI only). Listing them would be wrong and noisy: prefer the exact module list. The daemon closure is 7 packages (the 4 above plus their dependencies).

## Items that are not MIT, ISC, BSD, or Apache and affect the credits

1. **Onest font, SIL OFL 1.1.** The OFL asks that the copyright notice and license accompany any redistribution of the font, so the credits page must carry the "Copyright 2021 The Onest Project Authors" line and the OFL text (4.4 KB). Three `.woff2` files are emitted into the renderer (the small CyrillicExt file is probably inlined as a `data:` URI).
2. **Bun, MIT with static LGPL parts.** Bun's `LICENSE.md` (read from `raw.githubusercontent.com/oven-sh/bun/main/LICENSE.md` on 2026-11-23) says Bun is MIT, statically links JavaScriptCore and WebKit (LGPL-2) and tinycc (LGPL-2.1), and lists many linked libraries (BoringSSL "several licenses", lol-html BSD-3, lsquic MIT and BSD-3, simdutf and uSockets Apache-2.0, ICU, and others). It quotes the LGPL-2 requirement to let a user relink and says how (patched WebKit at `oven-sh/webkit`). The app ships the `bun` binary and no Bun license file (`layBun` in `scripts/bun-runtime.ts` copies the executable and `VERSION`). Credits should name Bun and link its `LICENSE.md`; how much more the LGPL needs is a legal call.
3. **Electron and Chromium.** Chromium's notices (many licenses, LGPL and MPL among them) are in `LICENSES.chromium.html`, already shipped. The credits can name Electron (MIT) and point to that file; opening it from the app is a main-process `shell.openPath` of a path main computes (macOS `process.resourcesPath`, Windows beside `process.execPath`). The renderer cannot read it: it is not under `app://clowdy`.
4. **Apache-2.0 packages** need the license text and attribution (9 packages, one text).
5. **BlueOak-1.0.0** (3 packages) is permissive but its notice requirement still means the text must be present.
6. **Material Icon Theme (MIT).** 1,253 SVGs and the manifest ship in the renderer. The icon artwork upstream derives from other sources (not checked).
7. **Shiki grammars and themes.** `@shikijs/langs` and `@shikijs/themes` declare MIT; the TextMate grammars inside are derived from many upstream projects with their own licenses. Declared only, not audited.
8. **Brand marks.** Claude, OpenAI, Cursor, GitHub logos are trademarks; the terms of their sources (Simple Icons, Cursor brand kit) were not checked.
9. **Reforma-derived code and assets.** Reforma's repo has no root `LICENSE` (the only Reforma license text is the eslint-config copy). Whether and how this code goes into a public repo, and what the credits say, is the owner's decision.
10. **Clowdy's own license** does not exist yet.

## How a credits list could be produced at build time

How the three builds work (all three are in `apps/desktop/scripts` or the daemon's): `buildRenderer` runs `vite build` (`vite.config.ts`) into a folder, `buildMain` and `bundleDaemon` call `Bun.build` and write `index.cjs`/`main.js`. The same `buildRenderer` output is used by `build.ts` (the app's own copy) and by `layoutOtaBundle` (OTA), where `hashFolder` hashes every file of the renderer folder into the signed manifest.

- **Renderer, exact.** A Vite plugin in `vite.config.ts` with `generateBundle(_, bundle)` reads `chunk.modules` of every chunk (module ids with absolute paths). Mapping ids containing `/node_modules/<pkg>/` to the package, its `package.json` (name, version, license, repository) and its license file gives the exact 232. Tried in the scratchpad with a wrapper config over the real one: the build took 4.7 s and the plugin needed no change to the project's config. The plugin can `emitFile` a `credits.json` asset, so it is in the renderer folder and therefore in the ASAR and the OTA manifest without changes to other scripts. Guard it with the `isProd` constant the config already has, so the `vite build --watch` of `./clowdy dev` skips it.
- **Main and daemon, exact.** `Bun.build` accepts `metafile: true` in the pinned Bun 1.4.4: the result's `metafile.inputs` keys are the bundled files (relative paths such as `../../node_modules/zod/index.js`). `buildMain` and `bundleDaemon` do not request it. Adding it touches `scripts/main-bundle.ts`, which is in `SHELL_PATHS`, so it needs a shell version bump to publish OTA bundles. A separate script (for example `scripts/credits.ts`) can repeat both builds into a temp folder with `metafile: true` and not touch `SHELL_PATHS`. Tried in the scratchpad: both builds ran in a few seconds.
- **Static alternative.** Walk `dependencies` of `apps/desktop` and `apps/daemon` from the root `node_modules` (hoisted linker, `bunfig.toml`). Simple, no extra build, and a superset (adds chroma-js and argparse here); tree-shaking is ignored.
- **Hand-written entries** (Electron/Chromium, Bun, ripgrep, Onest, Material Icon Theme, brand marks, Reforma-derived) cannot be derived from `node_modules`. They need a committed source file (the existing root `THIRD-PARTY-LICENSES.md`, or a JSON file the page also reads) merged into the generated list.
- **Size.** About 85 KB of JSON with each distinct license text stored once and a per-package line (name, version, license id, copyright line, repository): about 251 rows. Without deduplication it is about 350 KB.

## How a packaged renderer reads it

- A file in the renderer folder is served by `createProtocolHandler` (`src/main/protocol.ts`) at `app://clowdy/credits.json`. `.json` and `.txt` have content types; `.md` gets `application/octet-stream`. `connect-src 'self'` allows `fetch('/credits.json')`. The handler falls back to `index.html` for paths without an extension only, so a missing `credits.json` answers 404 (not an HTML page).
- Alternatively a lazy `import('./credits.json')` makes Vite emit a separate chunk loaded only on the About page (`script-src 'self'`).
- In OTA runs the handler also checks the file against the manifest (`rendererFiles`): the file is covered if it is in the renderer folder when `hashFolder` runs.
- In a development run, or the screenshot harness, the file may not exist: the page needs an empty state ("not available in a development run").

## Constraints

- A bundle drops license comments, so the credits page is the only place the notices are kept; it must be generated from the same build as the code it describes (an OTA bundle changes the renderer's packages without a shell).
- Main's packages change only with a shell (`apps/desktop/package.json` is in `SHELL_PATHS`), but the file that lists them would ride in the renderer's OTA bundle: they stay consistent only if both are produced from the same commit, which the bundle version already is.
- The `bun.lock` root and installed versions in this tree are the ones measured; they will move.

## Relevant files

- `apps/desktop/vite.config.ts`, `scripts/bundle.ts` (`buildRenderer`, `layoutOtaBundle`), `scripts/build.ts`, `scripts/main-bundle.ts`, `apps/daemon/scripts/bundle.ts`
- `apps/desktop/src/main/protocol.ts` (`CONTENT_SECURITY_POLICY`, `CONTENT_TYPES`, `createProtocolHandler`), `bundleManifest.ts` (`hashFolder`)
- `apps/desktop/electron-builder.ts` (`files`, `extraResources`)
- `apps/desktop/scripts/bun-runtime.ts`, `ripgrep.ts` (what is laid out beside the runtime)
- `THIRD-PARTY-LICENSES.md`, `packages/styles/src/assets/fonts/Onest/OFL.txt`, `packages/icons/src/assets/SOURCES.md`, `packages/icons/src/logo/SOURCES.md`
- `packages/components/src/FileIcon/fileIconTheme.ts` (the Material Icon Theme use), `packages/icons/README.md` (icons come from Reforma's Figma)

## Open questions

- The exact Bun and Chromium obligations (legal, not answerable from the code).
- Whether the credits must list the dev-only toolchain: no, it is not shipped; this was not evaluated for build tools.
- The upstream licenses of the Shiki grammars and the Material icon artwork.

## Assumptions and limits

- License ids are the `license` fields of the installed packages, not a scan of their texts.
- Built into the scratchpad only (`Vite` with a wrapper config and `Bun.build` with `metafile`); nothing was written into the repo. The throwaway scripts are in the scratchpad (`closure.mjs`, `pkgs.mjs`, `sizes.mjs`, `bunmeta.ts`, `vite.meta.config.mjs`).
- The older packaged builds in `apps/desktop/release/` and the stale `apps/desktop/app/` (dated 17 Nov) were used only to confirm that Electron's license files ship; their contents do not describe the current tree.
- Windows installer output was not inspected beyond `release/win-unpacked/`.

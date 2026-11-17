# Clowdy

Working name. A local desktop app for autonomous software development: chats, tasks, agents, and documents per project. See [`spec.md`](./spec.md) for the product spec and [`DESIGN.md`](./DESIGN.md) for the visual language.

This is the app skeleton: an Electron window (macOS, Windows) with the design system wired in and hot reload working. No product logic or backend yet.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Node 22.12+ (Vite and Electron's tooling run on it)

## Start

```sh
bun install
./clowdy dev      # the app with hot reload
./clowdy build    # unpacked app for this OS in apps/desktop/release/
```

`./clowdy build win` builds the Windows apps (x64, arm64) from any OS; a macOS build needs a Mac. Builds are unpacked and unsigned (ad-hoc signed on macOS): there are no installers yet. Where `./clowdy` cannot run, use `bun run clowdy dev` and `bun run clowdy build`.

`./clowdy dev`:

- builds the icon pack first (Turbo);
- serves the renderer from a Vite dev server on `127.0.0.1:5273` (`CLOWDY_RENDERER_PORT` changes the port), so edits to React, CSS, and the design system packages reach the open window without a reload;
- bundles main and preload with Bun and restarts the app when `src/main`, `src/preload`, or `src/shared` change;
- ends when you quit the app; after a crash it waits for the next save. Arguments after `dev` go to Electron.

## Layout

```
apps/desktop          Electron app: src/main, src/preload, src/renderer, src/shared
packages/components   Design system components
packages/styles       Tokens, reset, fonts
packages/icons        Icon packs
packages/lib          Shared helpers
packages/constants    Shared constants
```

Checks: `bun run lint`, `bun run typecheck`, `bun run test`.

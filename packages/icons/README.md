# @clowdy/icons

React/TypeScript icon library for the Clowdy design system. The package automatically discovers icon packs from the `src/` directory and generates optimized components with full TypeScript support.

## Overview

This package provides a flexible icon system that:

- **Automatically discovers icon packs** from subdirectories in `src/` (e.g., `src/12`, `src/14`, `src/16`, `src/custom-pack`)
- **Optimizes SVG files** by removing `fill` attributes, export artifacts (like `clip-path`), and unnecessary elements
- **Supports both SVG and PNG** icons (PNG files are copied as-is without optimization)
- **Generates React components** for each icon with proper TypeScript types
- **Provides base styles** for consistent icon rendering with `currentColor` inheritance
- **Offers strict TypeScript typing** that ensures icon names match their respective packs

## Usage

### Basic Usage

```tsx
import { Icon } from '@clowdy/icons';
import '@clowdy/icons/styles.css'; // Import base styles

// Using the Icon component with pack specification
<Icon pack="16" name="add" className="text-primary" title="Add item" />

// Without pack (uses default pack '16')
<Icon name="close" />
```

### Direct Icon Import

You can also import individual icons directly:

```tsx
import { AddIcon } from '@clowdy/icons/16';
import { CloseIcon } from '@clowdy/icons/14';

<AddIcon className="text-primary" title="Add" />
<CloseIcon size={20} />
```

## Package Structure

```
packages/icons/
├── src/
│   ├── [pack]/            # Source of truth - place your SVG/PNG files here (e.g., 12/, 14/, 16/)
│   ├── icons-metadata.json # Icon metadata configuration
│   └── styles.css         # Base icon styles
├── dist/                  # Built output
│   ├── [pack]/            # Generated React components per pack
│   └── index.ts           # Main entry point
└── scripts/
    ├── build.js           # Build script that generates components
    ├── sync-icons.js      # Pulls the icon packs from Figma into src/
    └── figma-auth.js      # Saved Figma token and the authorization prompt
```

`src/figma-icons-manifest.json` is written by the sync: it lists the files Figma owns.

## Commands

Run from `packages/icons`:

- `bun run build` — Generates React components from the SVG/PNG files in `src/` into `dist/`
- `bun run typecheck` — Type checks the package
- `bun run test` — Tests the Figma sync
- `bun run sync` — Pulls every icon pack from Figma (see below)

Run from the repository root: `./clowdy sync icons [pack ...]`, `./clowdy sync icons --list`, `./clowdy sync icons auth`.

`dist/` is not committed. `./clowdy dev` and `./clowdy build` build it through Turbo (`dev:prepare` / `build`) before the app starts.

## Syncing from Figma

The icons are drawn in Reforma's Figma file, and this repository pulls them from there with the same script Reforma uses. Draw or change an icon in Figma, then run `./clowdy sync icons` from the repository root.

- `./clowdy sync icons` — every pack, then the package build when a file changed
- `./clowdy sync icons 14` — only the exact `14` pack
- `./clowdy sync icons --list` — packs, node ids, and icon counts, without writing anything
- `./clowdy sync icons --json` — one versioned JSON result for scripts and agents: `addedFiles`, `changedFiles`, `removedFiles`, and the counts
- `./clowdy sync icons auth` — replaces and verifies the saved Figma token without syncing

How a Figma file turns into a pack, and how names and the `.` suffix work, is the same as in Reforma: the root frame's auto-layout children are packs, a pack frame holds one component set, and a variant `name=archive` becomes `archive.svg`. A variant that is not named for what it draws becomes a file of that name, so name it in Figma before you sync: renaming it there renames the file on the next run.

`src/icons-metadata.json` holds the source in `figma`:

```json
{
    "figma": {
        "excludeFromSyncSuffix": "~",
        "excludePacks": ["logo"],
        "iconsSourceUrl": "https://www.figma.com/design/FILE_KEY/FILE_NAME?node-id=1-2"
    }
}
```

`excludePacks` lists Figma packs that this repository does not take. `logo` is Reforma's own set of brand marks, while `src/logo` here is a different set, kept by hand (the agents and services Clowdy shows). `src/assets` is not in Figma at all. A pack ending with `excludeFromSyncSuffix` in Figma is skipped everywhere.

The sync changes only what the manifest lists. A file that is not in it, such as `src/16/keyboard.svg`, is never removed, but a Figma icon with the same name replaces it. Do not edit a managed SVG by hand: the next sync puts the Figma version back.

### Token

The first run asks for a Figma personal access token (the terminal prints the steps: Security, Personal access tokens, scope `file_content:read`) and keeps it in `~/.config/reforma/figma-access-token`, outside the repository. That is the file Reforma's `./reforma sync icons auth` writes, so authorizing in either repository works for both. `FIGMA_ACCESS_TOKEN` overrides it, for CI. Without a token a non-interactive run fails with `AUTH_REQUIRED`: run `./clowdy sync icons auth` in your own terminal, and never paste the token into a chat.

## What Happens During Build

When you run `bun run build`, the following happens:

1. **Overlay** — Generated files are written over `dist/`, which is not emptied first. After removing an icon from `src/`, delete `dist/` (it is git-ignored) and rebuild
2. **Process Icons** — Processes icons from `src/`:
   - **SVG files**: Optimized with SVGO to:
     - Remove `fill` attributes (icons inherit `currentColor`)
     - Remove `width` and `height` attributes (keeps `viewBox` for flexibility)
     - Remove export artifacts (`clip-path` attributes, empty `<defs>`, `<clipPath>` elements)
     - Clean up unnecessary attributes and elements
   - **PNG files**: Copied as-is (no optimization)
3. **Generate Components** — Creates:
   - React components for each icon (one per file)
   - Index files for each pack (barrel exports)
   - Main index.ts that exports all packs
   - Updates `package.json` exports for each pack
4. **Copy Assets** — Copies `styles.css` to `dist/`

## Adding New Icons

### Step-by-Step Guide

1. **Prepare your icons**:
   - Export SVG or PNG files from your design tool
   - Ensure file names match the desired icon names (e.g., `user-add.svg`, `settings.svg`)

2. **Place icons in the correct pack directory**:
   - Each subdirectory in `src/` represents an icon pack
   - Pack names can be numeric (e.g., `12`, `14`, `16`) or custom strings (e.g., `custom-pack`)
   - Example: To add an icon to pack `16`, place it in `src/16/my-icon.svg`

3. **Run the build command**:

   ```bash
   cd packages/icons
   bun run build
   ```

4. **Verify the results**:
   - Check `dist/[pack]/` to see generated components
   - TypeScript types will be automatically updated

### Rules for Adding Icons

- **Icon name = file name**: The icon name is derived from the file name (without extension)
  - `user-add.svg` → icon name `"user-add"`
  - `settings.png` → icon name `"settings"`
- **Skip optimization**: Add the suffix configured in `icons-metadata.json` to the source filename. With `optimization.excludeFromOptimizationSuffix: "."`, `google..svg` skips SVGO and still exports as `Google`.
- **Pattern exclusions**: `packs[pack].excludeFromOptimization` remains available for glob-based or pack-wide exclusions.
- **File format**: Supported formats are `.svg` and `.png`
- **Naming convention**: Use kebab-case for file names (e.g., `user-add.svg`, not `userAdd.svg`)

## SVG Requirements

For best results, SVG files should:

- Use `currentColor` for fills/strokes (or no fill attribute, which will be removed during optimization)
- Have a `viewBox` attribute (width/height will be removed)
- Not contain hard-coded colors
- Have transparent backgrounds (no raster data)

The optimization process will:

- ✅ Remove `fill` attributes (ensures `currentColor` inheritance)
- ✅ Remove `width` and `height` attributes
- ✅ Remove export artifacts (`clip-path`, empty `<defs>`, `<clipPath>`)
- ✅ Clean up unnecessary attributes
- ✅ Preserve `viewBox` for flexible sizing

## Styles

The package includes base styles in `styles.css` that ensure icons inherit `currentColor` by default. Import them in your application:

```tsx
// In your main CSS file (e.g., globals.css)
import '@clowdy/icons/styles.css';
```

The styles ensure:

- Icons inherit `currentColor` from their parent
- SVG and IMG elements properly handle sizing
- Consistent rendering across different icon types

## TypeScript Types

The package provides the following types:

- `IconPack` — Union type of all pack names
- `IconName` — Union type of all icon names across all packs
- `IconCollection` — Object type mapping packs to their icon names:
  ```typescript
  type IconCollection = {
    'pack1': 'close' | 'code' | ...;
    'pack2': 'H' | 'W' | ...;
    'pack3': 'add' | 'arrow-left' | ...;
  };
  ```
- `IconSize` — Union type of numeric pack sizes (for backward compatibility)
- `IconComponent` — Type for individual icon components

## Accessibility

The `Icon` component handles accessibility automatically:

- **With `title` prop**: Renders `role="img"` and `aria-label` with the title, plus a `<title>` element inside SVG
- **Without `title` prop**: Renders `aria-hidden="true"` to hide from assistive technologies

## Fallback Behavior

If an icon is not found in the specified pack, the `Icon` component returns `null`. There is no automatic fallback to other packs — TypeScript will catch these errors at compile time when using strict typing.

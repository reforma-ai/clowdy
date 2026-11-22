# File manager (`@clowdy/file-manager`)

A file tree and a text editor over any file system, forked from Reforma's `packages/file-manager`. It knows nothing of the daemon or of Electron: everything it reads and writes goes through a `FileSystemProvider` (`src/provider.ts`, with the contract in its comments), so the same code runs on the daemon's folders (`apps/desktop/src/renderer/daemon/httpFileSystem.ts`) and on `MemoryFileSystem` (tests, the fixture daemon). Paths are POSIX and relative to the provider's root; versions are opaque and only compared.

## Layout

```
src/FileManager.ts       One manager: tree, tabs, operations, search, clipboard, the filter; start/refresh/restore/snapshot
src/tree/FileTree.ts     The listing as an index (depth-3 first listing, folders loaded as they open), patched by watch changes, with exclude/hidden globs
src/documents/           TextDocument (load, edit, save with a version check, conflicts, rich Markdown, SVG preview) and Tabs
src/FileOperations.ts    Create, rename, move, copy, paste, delete, upload, with confirmations and the tree's bookkeeping
src/search/              Text search through a provider (or a host's SearchService)
src/memory/              MemoryFileSystem: a whole provider in memory, with versions, errors and watch events
src/react/               FileManagerView (the editor at the left, the sidebar of Files and Search at the right on an edge to drag), Explorer (react-arborist), EditorArea (tab strip, CodeMirror, Markdown pane), SearchView
specs/                   Vitest, in Node (`bun run test`): the manager, the tree, the documents, the operations, the search, the memory provider
```

## Rules

- **Never import the app.** The host gives a provider, the options (`exclude`, `hidden`, `notify`, `saveParticipants`, `search`) and, to the view, `sidebarOpen`, `sidebarWidth`, `onSidebarWidthChange` and `onSidebarRequest` (⌘P and ⇧⌘F were pressed while the sidebar is hidden: the host shows it). Add a host hook when something needs the app, not an import.
- **Differences from Reforma**, so a port of a later Reforma change knows where to look: the sidebar is at the right and resizable (`FileManagerView` is a `ResizablePanelGroup`, the sidebar panel built each time it opens with an id of its own, as `SidePanelLayout` does); the editor's tab strip is always there, with an optional toolbar slot, and the sidebar header has no `⋯` menu (`ExplorerPanelMenu` is unused: a host puts New file, New folder and Paste in the row menus, and "show hidden files" in a key and a setting); `onSidebarToggle` makes the Folder button that shows and hides the sidebar, at the end of the tab strip while it is hidden and at the end of the sidebar's header while it shows, so it stays in one place; the platform check is `src/react/platform.ts` (no `@reforma/lib/hotkeys`); the Explorer's react-dnd HTML5 backend listens on the tree's own element (`dndRootElement`, so the tree renders once its host element exists), not on the window, where it would cancel the native drags of the app's other screens (the task board's cards) and the drops of text into fields; the empty editor shows the `Page` icon in place of Reforma's logo; styles read Clowdy's tokens and `--clowdy-listbox-*`; a PDF is shown in the browser's viewer in a frame of a `blob:`, which the host's content security policy has to allow (`frame-src blob:`, as Reforma's does). The rest is Reforma's.
- **A provider fails with `FileSystemError`** and one of its five codes; the manager acts on the code (a `Conflict` is "Changed on disk", a `NotFound` closes a clean tab). A provider that cannot tell what changed sends `{ type: 'resync' }` and the manager lists again.
- **Text is UTF-8** (`decodeUtf8`): a file that is not is binary and opens as a preview or a note. Text over 5 MB and media over 50 MB do not open.
- **Test with `MemoryFileSystem`**, never a real disk. The Explorer and the editor need a browser and have no unit tests; look at them with the desktop app's screenshot harness (`?fixtures=static&panel=open&panelTab=files`).

# @clowdy/lib

Import: `import { mergeRefs, cn, ... } from '@clowdy/lib';`

**Before implementing a helper** (ref merging, class names, async/array/object utils, etc.), check this package and use the existing export instead of reimplementing.

## React

| Helper                      | Use                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **mergeRefs**               | Merge multiple refs (RefObject, callback refs, or null) into one. Use when forwarding a ref and keeping an internal ref. `mergeRefs(internalRef, forwardedRef)` → pass the result to `ref` / `panelRef` etc. |
| **dedentText**              | Strip shared leading space/tab indent from multi-line strings; prefer `CodeHighlighter` `dedent` at UI boundaries.                                                                                           |
| **leadingWhitespaceLength** | Length of leading `\s` on one line (e.g. fuzzy replace alignment).                                                                                                                       |
| **deepFreeze**              | Recursively `Object.freeze` an object/array graph (`objects`).                                                                                                                                               |

## Tests

Vitest specs live under `packages/lib/specs/` (not beside `src/` modules). Run from the package: `cd packages/lib && bun run test`.

## Other modules

The package also exports from: `array`, `async`, `clsx` (as `cn`), `comparers`, `dom`, `events`, `files` (`formatFileSize` with optional `round: 'up'`, `createObjectURL`, `revokeObjectURL`, `extensionForMediaType`, `mediaTypeForExtension`, `filesFromDataTransfer`), `logger`, `math`, `objects`, `observers`, `path`, `raf`, `string`, `url` (`isHttpUrl`), `values`. Prefer these over ad-hoc implementations.

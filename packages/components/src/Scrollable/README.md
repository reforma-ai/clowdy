# Scrollable

Custom scroll chrome (hidden native bars + styled thumbs).

**Default:** `<Scrollable>`.
**Headless:** `useScrollChrome` + `ScrollAxisSource`.

```ts
import {
  Scrollable,
  useScrollable,
  useScrollChrome,
  elementScrollAxisSource,
  ScrollChromeRoot,
  ScrollChromeBars,
  SCROLLABLE_OVERLAY_SLOT,
  type ScrollAxisSource,
} from '@clowdy/components';
```

## Pieces

| Piece                                   | Role                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| `Scrollable`                            | Scrollport + content + chrome                                  |
| `ScrollAxisSource`                      | One axis: metrics, `setOffset`, optional `subscribe` / observe |
| `elementScrollAxisSource`               | `HTMLElement` → `ScrollAxisSource`                             |
| `useScrollChrome`                       | Thumbs / edge attrs; drag writes through sources               |
| `ScrollChromeRoot` / `ScrollChromeBars` | Shell for headless composition                                 |

Axes are independent (different elements or element + remote).

## Basic

```tsx
<Scrollable vertical style={{ height: 240 }}>{longContent}</Scrollable>
<Scrollable horizontal vertical={false} style={{ width: 320, height: 120 }}>{wideRow}</Scrollable>
```

Props: `alwaysShowScrollbar`, `scrollbar` (`false` draws no thumb; wheel and `edgeFade` stay), `gap`, `edgeFade`, `onScroll`, `stickToBottom`, `containerClass` / `contentClass`.

Root edge attrs when an axis is enabled: `data-scroll-v-start|end`, `data-scroll-h-start|end`, `data-scroll-show-v|h`.

## Overlay

Child with `slot={SCROLLABLE_OVERLAY_SLOT}` (or `overlay` prop) sits beside the scroll container under `useScrollable()`:

```tsx
<div slot={SCROLLABLE_OVERLAY_SLOT}>…</div>
```

## External element chrome

Something else owns overflow (virtual list, arborist). Paint chrome only:

```tsx
const verticalSource = useMemo(
  () => elementScrollAxisSource(() => scrollEl, 'vertical'),
  [scrollEl],
);

const { rootRef, setScrollbarV, handlePointerDown, rootPointerHandlers } = useScrollChrome({
  verticalSource,
  sourceKey: scrollEl,
});

<ScrollChromeRoot rootRef={rootRef} vertical rootPointerHandlers={rootPointerHandlers}>
  {children}
  <ScrollChromeBars vertical setScrollbarV={setScrollbarV} onPointerDown={handlePointerDown} />
</ScrollChromeRoot>
```

Hide the native bar on the external element yourself.

**In Clowdy:** `LayersPanel`, `CodeTextarea` (CodeMirror `.cm-scroller`).

## Custom / remote source

No DOM scroll node in this window (iframe document, etc.):

```ts
type ScrollAxisSource = {
  getMetrics: () => ScrollAxisMetrics | null;
  setOffset: (offset: number) => void;
  subscribe?: (onChange: () => void) => () => void;
  getObserveElement?: () => Element | null;
};
```

Prefer optimistic `setOffset` (update local metrics immediately, then push remote) so the thumb stays under the pointer.

**In Clowdy:** `FramePageScrollChrome` (preview iframe page scroll).

## Split axes

```tsx
useScrollChrome({
  horizontalSource: elementScrollAxisSource(() => canvasEl, 'horizontal'),
  verticalSource: remotePageSource,
});
```

**In Clowdy:** PanZoom H = local `Scrollable`; V = frame remote source.

## Stick-to-bottom

```tsx
<Scrollable stickToBottom style={{ height: 360 }}>{lines}</Scrollable>
```

`useScrollable().stickToBottom` exposes `isAtBottom`, `enabled` / `setEnabled`, `scrollToBottom`.

## `useScrollChrome` options

| Option                                            | Notes                                           |
| ------------------------------------------------- | ----------------------------------------------- |
| `verticalSource` / `horizontalSource`             | Axis active when source is set                  |
| `sourceKey`                                       | Re-subscribe / re-observe when identity changes |
| `gap` / `alwaysShowScrollbar`                     | Same as `Scrollable`                            |

Returns `rootRef`, `setScrollbarV/H`, `handlePointerDown`, `rootPointerHandlers`, `edgesRef`, `redraw`.

Storybook: `Components/Layout/Scrollable`.

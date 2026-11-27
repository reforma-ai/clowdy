# Scrollable (agents)

Docs: **[README.md](./README.md)**. Import from `@clowdy/components/Scrollable`.

## Layout

`<Scrollable>` is already **three** nodes: root (`className`), overflow container (`containerClass`), content (`contentClass`). Do **not** wrap it in extra layout divs for height, flex, or padding — put those classes on the three slots. A wrapper around `Scrollable` is almost always wrong.

| Pattern                   | Where                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| `<Scrollable>`            | panels, chat, lists                                                |
| External element chrome   | file-manager `Explorer`, `CodeEditor` (`.cm-scroller`), `DiffView`; `Autocomplete` |
| Remote `ScrollAxisSource` | none yet                                                           |

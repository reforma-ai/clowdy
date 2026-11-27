/** The stacking layers of `--z-*` in `@clowdy/styles` (`tokens/local/zIndex.css`), for code that sets a z-index itself (`Modal.create({ zIndex })`). Keep the two in step. */
export const Z_INDEX = {
    modal: 100999,
    popover: 101000,
    /** Confirmations, above popovers (a delete from a menu), and dialogs opened from another dialog. */
    confirm: 101100,
    tooltip: 101200,
    toast: 102000,
} as const;

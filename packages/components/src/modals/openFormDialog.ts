import { Modal } from '../Modal';
import { Z_INDEX } from './layers';

import type { ModalOptionsRaw } from '../Modal/typings';

export interface OpenFormDialogOptions extends ModalOptionsRaw {
    width: NonNullable<ModalOptionsRaw['width']>;
    /** `confirm` stacks the dialog over popovers and other dialogs (opened from a menu or a dialog); `modal` (the default) over the page. */
    layer?: 'modal' | 'confirm';
}

/**
 * Opens a form dialog with the app's defaults: a dimmed backdrop, closed by an outside click, Escape or its close button, not draggable. Its content
 * is usually a `DialogLayout`. Any other `Modal` option can still be passed and wins.
 */
export function openFormDialog({ layer = 'modal', ...options }: OpenFormDialogOptions) {
    return Modal.create({
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        ...(layer === 'confirm' ? { zIndex: Z_INDEX.confirm } : {}),
        ...options,
    });
}

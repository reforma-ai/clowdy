import { Modal } from '@clowdy/components/Modal';

import { HelpOverlay } from './HelpOverlay';
import { hotkeys, type HotkeyRegistry } from './registry';

/** Opens the keyboard shortcuts overlay. A second call while it is open shows the open one again instead of stacking another. */
export function openHelp(registry: HotkeyRegistry = hotkeys): void {
    Modal.create({
        id: 'hotkeys-help',
        width: 560,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        // The list scrolls under a title that stays put, so the window itself does not.
        scrollable: false,
        // The list asks for focus as it mounts, but the window is still hidden then and the browser refuses, so the window takes it.
        // Hand it to the list once the window shows, or its arrow keys would have to wait for a click.
        onOpen: modal => modal.overlay.querySelector<HTMLElement>('[role="listbox"]')?.focus(),
        component: <HelpOverlay registry={ registry } />,
    });
}

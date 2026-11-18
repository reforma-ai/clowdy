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
        // The list scrolls under a search field that stays put, so the window itself does not.
        scrollable: false,
        component: <HelpOverlay registry={ registry } />,
    });
}

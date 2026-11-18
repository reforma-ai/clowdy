import { Hotkey, type HotkeySize } from '@clowdy/components/Hotkey';

import { commandHint, type HintPresses } from './react';

import type { HotkeyRegistry } from './registry';

/** One press in one capsule, several as a sequence ("G then T"). */
export function PressesHotkey({ presses, size }: { presses: HintPresses; size?: HotkeySize }) {
    return presses.length === 1 ? <Hotkey hotkey={ presses[0] } size={ size } /> : <Hotkey sequence={ presses } size={ size } />;
}

/**
 * The key hint of a command, for a menu item's `endAffix` or a button's content: `<MenuItem endAffix={ <CommandHotkey id="tasks.create" /> } />`.
 * Draws nothing while the command is unknown or cannot run, so a hint never sits on an action that does nothing.
 */
export function CommandHotkey({ id, registry, size }: { id: string; registry?: HotkeyRegistry; size?: HotkeySize }) {
    const presses = commandHint(id, registry);

    return presses ? <PressesHotkey presses={ presses } size={ size } /> : null;
}

import { Hotkey } from './Hotkey';

import type { ReactNode } from 'react';
import type { HotkeyValue } from './hotkeysToSymbols';

/** Label + shortcut for Button / ToggleButton tooltips. */
export function tooltipWithHotkey(label: string, hotkey: HotkeyValue): ReactNode {
    return (
        <>
            {label} <Hotkey hotkey={hotkey} size="sm" />
        </>
    );
}

/** Label + a key sequence ("G then C") for Button / ToggleButton tooltips. */
export function tooltipWithSequence(label: string, sequence: readonly HotkeyValue[]): ReactNode {
    return (
        <>
            {label} <Hotkey sequence={sequence} size="sm" />
        </>
    );
}

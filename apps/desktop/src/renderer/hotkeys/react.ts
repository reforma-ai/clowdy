import { tooltipWithHotkey, tooltipWithSequence } from '@clowdy/components/Hotkey';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

import { hotkeys, type Command, type HotkeyRegistry } from './registry';

/** A command as a component writes it: the scope comes from `useCommands`. */
export type ScopedCommand = Omit<Command, 'scope'>;

/** The presses of one key sequence as key names for `Hotkey`: `[['mod', 'k']]` is one press with a modifier, `[['g'], ['c']]` is two presses in a row. */
export type HintPresses = readonly (readonly string[])[];

/**
 * The keys a hint shows for the command: its first keys, in the names `Hotkey` takes, or `undefined` when no hint should show.
 * That is when no command has the id, or when the command cannot run now (its scope is not on the stack, or its `when` says no),
 * because a key hint on something that does nothing is noise.
 *
 * Reactive: the registry's commands and scope stack are MobX observables, and so is whatever a command's `when` reads.
 * Call it while rendering a component (the app's components are observers) and the component renders again when the answer changes.
 */
export function commandHint(id: string, registry: HotkeyRegistry = hotkeys): HintPresses | undefined {
    const entry = registry.entries.find(candidate => candidate.command.id === id);

    if (!entry || !registry.isEntryLive(entry)) return undefined;

    const [first] = entry.sequences[registry.family];

    return first?.display;
}

/**
 * Tooltip content: the label and the command's keys, or `undefined` while the command has no hint (see `commandHint`).
 * A control whose label is not visible otherwise writes `commandTooltip(label, id) ?? label`.
 */
export function commandTooltip(label: string, id: string, registry?: HotkeyRegistry): ReactNode {
    const presses = commandHint(id, registry);

    if (!presses) return undefined;

    return presses.length === 1 ? tooltipWithHotkey(label, presses[0]) : tooltipWithSequence(label, presses);
}

/**
 * Keeps a scope on the scope stack while the component is mounted, so its commands win over those of outer scopes.
 * The stack follows the order the scopes were pushed, which is mount order, and React runs a child's effects before its parent's.
 * So a scope that opens later (a popover, a dialog, a picker) is always on top, but a scope pushed by a child that mounts in the same commit as its parent ends up below the parent's.
 * A screen pushes one scope for itself (`tasks`), and a nested scope that mounts with it should not reuse its keys.
 */
export function useHotkeyScope(name: string, registry: HotkeyRegistry = hotkeys): void {
    useEffect(() => registry.pushScope(name), [name, registry]);
}

/**
 * Defines commands in a scope while the component is mounted. The commands are registered again only when their id, title, group, keys or flags change,
 * so a new array or new closures on every render are fine: the latest `handler` and `when` always run. Does not push the scope, see `useHotkeyScope`.
 */
export function useCommands(scope: string, commands: readonly ScopedCommand[], registry: HotkeyRegistry = hotkeys): void {
    const latest = useRef(commands);
    const signature = JSON.stringify(commands.map(({ id, title, group, keys, inInputs, inOverlays, repeat }) => [id, title, group, keys, inInputs, inOverlays, repeat]));

    useLayoutEffect(() => {
        latest.current = commands;
    });

    useEffect(() => {
        const current = (id: string) => latest.current.find(command => command.id === id);
        const disposers = latest.current.map(command => registry.defineCommand({
            ...command,
            scope,
            when: () => current(command.id)?.when?.() ?? true,
            handler: event => current(command.id)?.handler(event),
        }));

        return () => disposers.forEach(dispose => dispose());
    }, [scope, signature, registry]);
}

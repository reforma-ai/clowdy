import { useEffect, useLayoutEffect, useRef } from 'react';

import { hotkeys, type Command, type HotkeyRegistry } from './registry';

/** A command as a component writes it: the scope comes from `useCommands`. */
export type ScopedCommand = Omit<Command, 'scope'>;

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

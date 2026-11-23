/**
 * The hotkey layer: commands with keys, scopes that say which commands are live, and one dispatcher that runs them.
 *
 * Define commands (`useCommands` in a component, `defineCommand` anywhere else) with tinykeys' key grammar:
 * `k`, `Shift+r`, `$mod+k` (Cmd on macOS, Ctrl elsewhere), `ArrowDown`, `Escape`, `g c` (a chord: `g`, then `c`),
 * or `{ mac: '$mod+Backspace', win: '$mod+Delete' }`. A symbol key (`?`, `/`) also takes Shift; other modifiers are strict.
 * `useHotkeyScope('tasks')` makes the commands of the `tasks` scope live while a component is mounted; `app` is always live.
 * When two live commands share keys the innermost scope wins, and `defineCommand` throws when keys collide inside one scope or against `app`.
 * `when` says whether a command exists for the screen now; `focus` says whether the keyboard focus is where its keys belong. Both gate the dispatcher,
 * but only `when` reaches the key hints, which must not change with where the focus sits.
 *
 * Single keys are off while a text field has focus and while a dialog, popover or `Modal` overlay is open (the key came from inside one),
 * unless the command sets `inInputs` or `inOverlays`. IME composition is ignored. A held key runs only a command with `repeat`.
 * A command that takes a key stops it there: React Aria and the page never see it.
 *
 * For display: `commandPresses(command)` is the presses of the first keys as key names for `hotkeysToSymbols`,
 * `commandSequences(command)` lists every alternative, `listCommands()` the live and all commands, `hotkeys.pending` the chord waiting for its next key.
 * Key hints: `commandHint(id)` is the keys to show for a command, and `undefined` while it cannot run (a hint on a dead action is noise); it is reactive,
 * so call it while rendering. `<CommandHotkey id />` draws it (a menu item's `endAffix`), `commandTooltip(label, id)` is tooltip content (`undefined` without a hint).
 * `<ChordHud />` shows a pending chord; the shell mounts it. `helpEntries(registry)` (`./helpEntries`) lists the commands with their keys, by group, for the shortcuts page of Settings,
 * which reads the whole keymap (`shortcutEntries` in `shell/keymap.ts`) and not the live registry: a section registers its commands while it is mounted, and Settings takes its place.
 * Tests build an isolated `createRegistry(platform)` and pass it to `installDispatcher`, `useCommands`, `useHotkeyScope`, `commandHint` and `<CommandHotkey registry />`.
 */

import { hotkeys } from './registry';

import type { Command } from './registry';

export { ChordHud } from './ChordHud';
export { CommandHotkey, PressesHotkey } from './CommandHotkey';
export { installDispatcher } from './dispatcher';
export { commandHint, commandTooltip, type ScopedCommand, useCommands, useHotkeyScope } from './react';
export {
    type Command,
    type CommandKeys,
    commandPresses,
    commandSequences,
    createRegistry,
    findKeyConflicts,
    HotkeyRegistry,
    hotkeys,
    type KeyConflict,
    type Keys,
    type PendingChord,
    type Platform,
    type PlatformKeys,
} from './registry';

/** Registers a command in the app's registry and returns the function that removes it. */
export const defineCommand = (command: Command) => hotkeys.defineCommand(command);

/** The commands the app has defined, and the ones that are live now. */
export const listCommands = () => hotkeys.listCommands();

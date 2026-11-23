import { SETTINGS_COMMAND, SETTINGS_KEYS } from '../features/settings/commands';
import { SIDE_PANEL_COMMAND, SIDE_PANEL_EXPAND_COMMAND, SIDE_PANEL_EXPAND_KEYS, SIDE_PANEL_KEYS, SIDE_PANEL_TAB_KEYS, SIDE_PANEL_TAB_LABELS, sidePanelTabCommand, TERMINAL_COMMAND, TERMINAL_KEYS } from '../features/sidePanel';
import { SIDE_PANEL_TABS } from '../stores';

import type { ScopedCommand } from '../hotkeys';
import type { NavHistory, RootStore } from '../stores';

/** The id of the command that starts a chat, which the New chat row asks for its hint. */
export const NEW_CHAT_COMMAND = 'chats.new';

/** The brackets by their physical keys: on a Cyrillic layout the key at `[` types a letter, and the key event names no bracket. */
const BACK_KEYS = '$mod+BracketLeft';
const FORWARD_KEYS = '$mod+BracketRight';

/** What the shell's commands need of the root store. */
export interface ShellCommandsRoot extends Pick<RootStore, 'phase' | 'selectedProjectId' | 'selectedProjectUi' | 'showsProjectScreen' | 'ui'> {
    history: Pick<NavHistory, 'back' | 'forward' | 'canGoBack' | 'canGoForward'>;
}

/**
 * The commands that work in the whole window, for `useCommands('app', …)`: the shortcuts page of Settings, `Cmd+,` for the Settings window, `Cmd+N` for a new chat, `Cmd+Esc` (`Ctrl+Shift+B` off a Mac) for
 * the side panel, `Cmd+Shift+Enter` (`Ctrl+Shift+Enter`) for its expanded view, `Ctrl+`` for its terminal, `Cmd+0` to `Cmd+4` for its tabs, and back and forward.
 * `?` opens Settings on its Shortcuts page, once the window shows anything to open it over: while the app loads or cannot reach its daemon, the key reaches the page.
 * A new chat needs a selected project, and also leaves Settings.
 * `Cmd+N` shows the new-chat page, and works from a text field too: the message box is the place it is most wanted.
 * Back and forward are off while there is nowhere to go, so the key reaches the page and the hint is not shown. Text fields keep `Cmd+[` for outdenting.
 */
export function shellCommands(root: ShellCommandsRoot): ScopedCommand[] {
    return [
        {
            id: 'help.open',
            title: 'Show keyboard shortcuts',
            group: 'General',
            keys: ['?', '$mod+/', '$mod+?'],
            when: () => root.phase === 'ready',
            handler: () => root.ui.openSettings('shortcuts'),
        },
        {
            id: SETTINGS_COMMAND,
            title: 'Open settings',
            group: 'General',
            keys: SETTINGS_KEYS,
            // From a text field too: the message box is where a hand is.
            inInputs: true,
            when: () => root.phase === 'ready',
            handler: () => root.ui.openSettings(),
        },
        {
            id: NEW_CHAT_COMMAND,
            title: 'New chat',
            group: 'Agents',
            keys: '$mod+n',
            inInputs: true,
            when: () => root.selectedProjectId !== null,
            handler: () => {
                if (!root.selectedProjectId) return;

                root.ui.closeSettings();
                root.ui.forProject(root.selectedProjectId).openDraft();
            },
        },
        {
            id: SIDE_PANEL_COMMAND,
            title: 'Toggle side panel',
            group: 'General',
            keys: SIDE_PANEL_KEYS,
            inInputs: true,
            // Only where the panel and its rail are: a window that shows no project has none, and the key then reaches the page.
            when: () => root.showsProjectScreen,
            handler: () => {
                if (root.selectedProjectId) root.ui.forProject(root.selectedProjectId).toggleSidePanel();
            },
        },
        {
            id: SIDE_PANEL_EXPAND_COMMAND,
            title: 'Toggle expanded side panel',
            group: 'General',
            keys: SIDE_PANEL_EXPAND_KEYS,
            inInputs: true,
            // Only with the panel open, as the button in the title band's corner: with it shut there is nothing to expand, and the key reaches the page.
            // And not on a tab that is full already (Tasks).
            when: () => root.showsProjectScreen && root.selectedProjectUi?.sidePanelOpen === true && !root.selectedProjectUi.sidePanelTabIsFull,
            handler: () => root.selectedProjectUi?.toggleSidePanelExpanded(),
        },
        {
            id: TERMINAL_COMMAND,
            title: 'Toggle terminal',
            group: 'General',
            keys: TERMINAL_KEYS,
            // From a text field too, and from the terminal itself, which hands the key on (`isAppShortcut`).
            inInputs: true,
            when: () => root.showsProjectScreen,
            handler: () => {
                if (root.selectedProjectId) root.ui.forProject(root.selectedProjectId).toggleSidePanelTab('terminal');
            },
        },
        // The tabs of the panel, one key to open the panel on a tab and the same key to shut it, as a click on the tab's item in the rail does, from a text field too, and from the terminal, which hands the keys on (`isAppShortcut`).
        ...SIDE_PANEL_TABS.map(tab => ({
            id: sidePanelTabCommand(tab),
            title: `Toggle ${ SIDE_PANEL_TAB_LABELS[tab] } in the side panel`,
            group: 'General',
            keys: SIDE_PANEL_TAB_KEYS[tab],
            inInputs: true,
            when: () => root.showsProjectScreen,
            handler: () => {
                if (root.selectedProjectId) root.ui.forProject(root.selectedProjectId).toggleSidePanelTab(tab);
            },
        })),
        { id: 'nav.back', title: 'Go back', group: 'Navigation', keys: BACK_KEYS, when: () => root.history.canGoBack, handler: () => root.history.back() },
        { id: 'nav.forward', title: 'Go forward', group: 'Navigation', keys: FORWARD_KEYS, when: () => root.history.canGoForward, handler: () => root.history.forward() },
    ];
}

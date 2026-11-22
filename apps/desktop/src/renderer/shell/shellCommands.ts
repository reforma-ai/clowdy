import { SIDE_PANEL_COMMAND, SIDE_PANEL_KEYS, SIDE_PANEL_TAB_KEYS, SIDE_PANEL_TAB_LABELS, sidePanelTabCommand, TERMINAL_COMMAND, TERMINAL_KEYS } from '../features/sidePanel';
import { SIDE_PANEL_TABS } from '../stores';

import type { ScopedCommand } from '../hotkeys';
import type { NavHistory, RootStore, Section } from '../stores';

/** The id of the command that switches to the section, which the Rail asks for the hint of its button. */
export const navCommandId = (section: Section) => `nav.${ section }`;

/** The id of the command that starts a chat, which the New chat row asks for its hint. */
export const NEW_CHAT_COMMAND = 'chats.new';

/** `G` then a letter, the way Linear goes places: A for Agents (the chats and the runs below them), T for Tasks, D for Docs. */
const SECTION_CHORDS: Record<Section, { title: string; keys: string }> = {
    agents: { title: 'Go to Agents', keys: 'g a' },
    tasks: { title: 'Go to Tasks', keys: 'g t' },
    docs: { title: 'Go to Docs', keys: 'g d' },
};

/** The brackets by their physical keys: on a Cyrillic layout the key at `[` types a letter, and the key event names no bracket. */
const BACK_KEYS = '$mod+BracketLeft';
const FORWARD_KEYS = '$mod+BracketRight';

/** What the shell's commands need of the root store. */
export interface ShellCommandsRoot extends Pick<RootStore, 'phase' | 'selectedProjectId' | 'showsProjectScreen' | 'ui'> {
    history: Pick<NavHistory, 'back' | 'forward' | 'canGoBack' | 'canGoForward'>;
}

/**
 * The commands that work in every section, for `useCommands('app', …)`: the shortcuts page of Settings, the `G` chords that switch sections, `Cmd+N` for a new chat, `Cmd+Esc` (`Ctrl+Shift+B` off a Mac) for
 * the side panel, `Ctrl+`` for its terminal, `Cmd+0`, `Cmd+1` and `Cmd+2` for its tabs, and back and forward.
 * `?` opens Settings on its Shortcuts page, once the window shows anything to open it over: while the app loads or cannot reach its daemon, the key reaches the page.
 * A section chord and a new chat need a selected project, as the Rail's buttons do, and also leave Settings.
 * `Cmd+N` shows the new-chat page of the Agents section whichever section is open, and works from a text field too: the message box is the place it is most wanted.
 * Back and forward are off while there is nowhere to go, so the key reaches the page and the hint is not shown. Text fields keep `Cmd+[` for outdenting.
 */
export function shellCommands(root: ShellCommandsRoot): ScopedCommand[] {
    const sections = (Object.keys(SECTION_CHORDS) as Section[]).map((section): ScopedCommand => ({
        id: navCommandId(section),
        title: SECTION_CHORDS[section].title,
        group: 'Navigation',
        keys: SECTION_CHORDS[section].keys,
        when: () => root.selectedProjectId !== null,
        handler: () => {
            if (root.selectedProjectId) root.ui.showSection(root.ui.forProject(root.selectedProjectId), section);
        },
    }));

    return [
        {
            id: 'help.open',
            title: 'Show keyboard shortcuts',
            group: 'General',
            keys: ['?', '$mod+/', '$mod+?'],
            when: () => root.phase === 'ready',
            handler: () => root.ui.openSettings('shortcuts'),
        },
        ...sections,
        {
            id: NEW_CHAT_COMMAND,
            title: 'New chat',
            group: 'Agents',
            keys: '$mod+n',
            inInputs: true,
            when: () => root.selectedProjectId !== null,
            handler: () => {
                if (!root.selectedProjectId) return;

                const projectUi = root.ui.forProject(root.selectedProjectId);

                root.ui.showSection(projectUi, 'agents');
                projectUi.openDraft();
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

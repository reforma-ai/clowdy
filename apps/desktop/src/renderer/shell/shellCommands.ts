import { SIDE_PANEL_COMMAND, SIDE_PANEL_KEYS } from '../features/sidePanel';

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
export interface ShellCommandsRoot extends Pick<RootStore, 'selectedProjectId' | 'showsProjectScreen' | 'ui'> {
    history: Pick<NavHistory, 'back' | 'forward' | 'canGoBack' | 'canGoForward'>;
}

/**
 * The commands that work in every section, for `useCommands('app', …)`: the help overlay, the `G` chords that switch sections, `Cmd+N` for a new chat, `Cmd+Shift+B` for
 * the side panel, and back and forward.
 * A section chord and a new chat need a selected project, as the Rail's buttons do, and also leave Settings.
 * `Cmd+N` shows the new-chat page of the Agents section whichever section is open, and works from a text field too: the message box is the place it is most wanted.
 * Back and forward are off while there is nowhere to go, so the key reaches the page and the hint is not shown. Text fields keep `Cmd+[` for outdenting.
 */
export function shellCommands(root: ShellCommandsRoot, openHelp: () => void): ScopedCommand[] {
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
        { id: 'help.open', title: 'Show keyboard shortcuts', group: 'General', keys: ['?', '$mod+/', '$mod+?'], handler: () => openHelp() },
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
            // Only where the panel and its button are: a window that shows no project has none, and the key then reaches the page.
            when: () => root.showsProjectScreen,
            handler: () => {
                if (root.selectedProjectId) root.ui.forProject(root.selectedProjectId).toggleSidePanel();
            },
        },
        { id: 'nav.back', title: 'Go back', group: 'Navigation', keys: BACK_KEYS, when: () => root.history.canGoBack, handler: () => root.history.back() },
        { id: 'nav.forward', title: 'Go forward', group: 'Navigation', keys: FORWARD_KEYS, when: () => root.history.canGoForward, handler: () => root.history.forward() },
    ];
}

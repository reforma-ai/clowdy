import type { ScopedCommand } from '../hotkeys';
import type { NavHistory, RootStore, Section } from '../stores';

/** The id of the command that switches to the section, which the Rail asks for the hint of its button. */
export const navCommandId = (section: Section) => `nav.${ section }`;

/** `G` then a letter, the way Linear goes places: C for Chats, T for Tasks, A for Agents, D for Docs. */
const SECTION_CHORDS: Record<Section, { title: string; keys: string }> = {
    chats: { title: 'Go to Chats', keys: 'g c' },
    tasks: { title: 'Go to Tasks', keys: 'g t' },
    agents: { title: 'Go to Agents', keys: 'g a' },
    docs: { title: 'Go to Docs', keys: 'g d' },
};

/** The brackets by their physical keys: on a Cyrillic layout the key at `[` types a letter, and the key event names no bracket. */
const BACK_KEYS = '$mod+BracketLeft';
const FORWARD_KEYS = '$mod+BracketRight';

/** What the shell's commands need of the root store. */
export interface ShellCommandsRoot extends Pick<RootStore, 'selectedProjectId' | 'ui'> {
    history: Pick<NavHistory, 'back' | 'forward' | 'canGoBack' | 'canGoForward'>;
}

/**
 * The commands that work in every section, for `useCommands('app', …)`: the help overlay, the `G` chords that switch sections, and back and forward.
 * A section chord needs a selected project, as the Rail's buttons do, and also leaves Settings.
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
        { id: 'nav.back', title: 'Go back', group: 'Navigation', keys: BACK_KEYS, when: () => root.history.canGoBack, handler: () => root.history.back() },
        { id: 'nav.forward', title: 'Go forward', group: 'Navigation', keys: FORWARD_KEYS, when: () => root.history.canGoForward, handler: () => root.history.forward() },
    ];
}

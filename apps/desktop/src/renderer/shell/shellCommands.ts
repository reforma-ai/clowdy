import type { ScopedCommand } from '../hotkeys';
import type { RootStore, Section } from '../stores';

/** The id of the command that switches to the section, which the Rail asks for the hint of its button. */
export const navCommandId = (section: Section) => `nav.${ section }`;

/** `G` then a letter, the way Linear goes places: C for Chats, T for Tasks, A for Agents, D for Docs. */
const SECTION_CHORDS: Record<Section, { title: string; keys: string }> = {
    chats: { title: 'Go to Chats', keys: 'g c' },
    tasks: { title: 'Go to Tasks', keys: 'g t' },
    agents: { title: 'Go to Agents', keys: 'g a' },
    docs: { title: 'Go to Docs', keys: 'g d' },
};

/**
 * The commands that work in every section, for `useCommands('app', …)`: the help overlay, and the `G` chords that switch sections.
 * A section chord needs a selected project, as the Rail's buttons do, and also leaves Settings.
 */
export function shellCommands(root: Pick<RootStore, 'selectedProjectId' | 'ui'>, openHelp: () => void): ScopedCommand[] {
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
        { id: 'help.open', title: 'Show keyboard shortcuts', group: 'General', keys: ['?', '$mod+/'], handler: () => openHelp() },
        ...sections,
    ];
}

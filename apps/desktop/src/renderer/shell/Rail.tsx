import { Checkbox } from '@clowdy/icons/14';
import { Team } from '@clowdy/icons/16';

import { commandTooltip } from '../hotkeys';
import { RailItem } from '../shared/RailItem';
import { SECTIONS, useRootStore, type Section } from '../stores';
import styles from './Rail.module.css';
import { navCommandId } from './shellCommands';

import type { ComponentType, SVGProps } from 'react';

/** Each icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
const SECTION_VIEWS: Record<Section, { label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; size: number }> = {
    agents: { label: 'Agents', icon: Team, size: 16 },
    tasks: { label: 'Tasks', icon: Checkbox, size: 14 },
};

/** The left rail: the sections of the project. */
export function Rail() {
    const root = useRootStore();
    const ui = root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return (
        <nav className={ styles.rail } aria-label="Sections">
            <div className={ styles.sections }>
                { SECTIONS.map((section) => {
                    const { label, icon, size } = SECTION_VIEWS[section];

                    return (
                        // The label is already on the button, so the tooltip only appears to teach the chord, and not at all while the chord does nothing.
                        <RailItem
                            key={ section }
                            label={ label }
                            icon={ icon }
                            size={ size }
                            disabled={ !ui }
                            current={ !!ui && ui.section === section }
                            tooltip={ commandTooltip(label, navCommandId(section)) }
                            onPress={ () => ui && root.ui.showSection(ui, section) }
                        />
                    );
                }) }
            </div>
        </nav>
    );
}

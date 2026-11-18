import { Tooltip } from '@clowdy/components/Tooltip';
import { Checkbox } from '@clowdy/icons/14';
import { File, Settings, Team } from '@clowdy/icons/16';
import { cn } from '@clowdy/lib';

import { commandTooltip } from '../hotkeys';
import { SECTIONS, useRootStore, type Section } from '../stores';
import styles from './Rail.module.css';
import { navCommandId } from './shellCommands';

import type { ComponentType, SVGProps } from 'react';

/** Each icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
const SECTION_VIEWS: Record<Section, { label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; size: number }> = {
    agents: { label: 'Agents', icon: Team, size: 16 },
    tasks: { label: 'Tasks', icon: Checkbox, size: 14 },
    docs: { label: 'Docs', icon: File, size: 16 },
};

/** The left rail: the three sections, and Settings pinned at the bottom. */
export function Rail() {
    const root = useRootStore();
    const ui = root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return (
        <nav className={ styles.rail } aria-label="Sections">
            <div className={ styles.sections }>
                { SECTIONS.map((section) => {
                    const { label, icon: Icon, size } = SECTION_VIEWS[section];

                    return (
                        // The label is already on the button, so the tooltip only appears to teach the chord, and not at all while the chord does nothing.
                        <Tooltip key={ section } content={ commandTooltip(label, navCommandId(section)) } placement="right">
                            <button
                                type="button"
                                className={ styles.item }
                                disabled={ !ui }
                                aria-current={ ui && !root.ui.settingsOpen && ui.section === section ? 'page' : undefined }
                                onClick={ () => ui && root.ui.showSection(ui, section) }
                            >
                                <span className={ styles.glyph }>
                                    <Icon width={ size } height={ size } aria-hidden />
                                </span>
                                <span className={ styles.label }>{ label }</span>
                            </button>
                        </Tooltip>
                    );
                }) }
            </div>

            <button
                type="button"
                className={ cn(styles.item, styles.settings) }
                aria-current={ root.ui.settingsOpen ? 'page' : undefined }
                onClick={ () => root.ui.openSettings() }
            >
                <span className={ styles.glyph }>
                    <Settings width={ 16 } height={ 16 } aria-hidden />
                </span>
                <span className={ styles.label }>Settings</span>
            </button>
        </nav>
    );
}

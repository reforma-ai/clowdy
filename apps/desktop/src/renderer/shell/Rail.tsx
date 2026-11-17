import { Checkbox } from '@clowdy/icons/14';
import { Chat, File, Settings, Team } from '@clowdy/icons/16';
import { cn } from '@clowdy/lib';

import { SECTIONS, useRootStore, type Section } from '../stores';
import styles from './Rail.module.css';

import type { ComponentType, SVGProps } from 'react';

/** Each icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
const SECTION_VIEWS: Record<Section, { label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; size: number }> = {
    chats: { label: 'Chats', icon: Chat, size: 16 },
    tasks: { label: 'Tasks', icon: Checkbox, size: 14 },
    agents: { label: 'Agents', icon: Team, size: 16 },
    docs: { label: 'Documents', icon: File, size: 16 },
};

/** The left rail: the four sections, and Settings pinned at the bottom. */
export function Rail() {
    const root = useRootStore();
    const ui = root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return (
        <nav className={ styles.rail } aria-label="Sections">
            <div className={ styles.sections }>
                { SECTIONS.map((section) => {
                    const { label, icon: Icon, size } = SECTION_VIEWS[section];

                    return (
                        <button
                            key={ section }
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

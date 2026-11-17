import { Checkbox, Message, Page, Settings, Team } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { SECTIONS, useRootStore, type Section } from '../stores';
import styles from './Rail.module.css';

import type { ComponentType, SVGProps } from 'react';

const SECTION_VIEWS: Record<Section, { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = {
    chats: { label: 'Chats', icon: Message },
    tasks: { label: 'Tasks', icon: Checkbox },
    agents: { label: 'Agents', icon: Team },
    docs: { label: 'Documents', icon: Page },
};

const ICON_SIZE = 20;

/** The left rail: the four sections, and Settings pinned at the bottom. */
export function Rail() {
    const root = useRootStore();
    const ui = root.selectedProjectId ? root.ui.forProject(root.selectedProjectId) : undefined;

    return (
        <nav className={ styles.rail } aria-label="Sections">
            <div className={ styles.sections }>
                { SECTIONS.map((section) => {
                    const { label, icon: Icon } = SECTION_VIEWS[section];

                    return (
                        <button
                            key={ section }
                            type="button"
                            className={ styles.item }
                            disabled={ !ui }
                            aria-current={ ui && !root.ui.settingsOpen && ui.section === section ? 'page' : undefined }
                            onClick={ () => ui && root.ui.showSection(ui, section) }
                        >
                            <Icon width={ ICON_SIZE } height={ ICON_SIZE } />
                            { label }
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
                <Settings width={ ICON_SIZE } height={ ICON_SIZE } />
                Settings
            </button>
        </nav>
    );
}

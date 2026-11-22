import { Text } from '@clowdy/components/Text';
import { Folder } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { PathText } from '../../shared/PathText';
import { ProjectIcon } from '../../shared/ProjectIcon';
import { useProjectState, useProjectUi } from '../../stores';
import { chatFolder, draftTarget } from '../agents/agentTree';
import styles from './InfoTab.module.css';

import type { ProjectFolder } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { ProjectState, ProjectUi } from '../../stores';

/**
 * The folder the window is working in: the folder of the open chat, or of the new chat that is being made, while the Agents section is on show, and the
 * project's main folder in every other case, since the other sections belong to the project and not to a folder.
 */
export function currentFolder(project: Pick<ProjectState, 'chats' | 'project'>, ui: Pick<ProjectUi, 'section' | 'chatId' | 'draft' | 'draftFolderId'>): ProjectFolder {
    const { folders } = project.project;

    if (ui.section === 'agents') {
        const found = ui.chatId ? chatFolder(project.chats, folders, ui.chatId) : undefined;

        if (found) return found.folder;

        if (ui.draft) return draftTarget(folders, ui.draftFolderId).folder;
    }

    return mainFolder(project.project);
}

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
    return (
        <div className={ styles.row }>
            <dt className={ styles.label }>
                <span className={ styles.icon }>{ icon }</span>
                <Text color="secondary">{ label }</Text>
            </dt>
            <dd className={ styles.value }>{ children }</dd>
        </div>
    );
}

/** The panel's first and only tab for now: what the window is working on, as a short list. */
export function InfoTab() {
    const project = useProjectState();
    const ui = useProjectUi();
    const folder = currentFolder(project, ui);

    return (
        <dl className={ styles.info }>
            <InfoRow icon={ <ProjectIcon project={ project.project } /> } label="Project">
                <Text truncate>{ project.project.name }</Text>
            </InfoRow>
            <InfoRow icon={ <Folder aria-hidden="true" /> } label="Folder">
                <PathText path={ folder.path } />
            </InfoRow>
        </dl>
    );
}

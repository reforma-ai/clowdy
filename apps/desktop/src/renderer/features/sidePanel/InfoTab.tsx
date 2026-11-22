import { Text } from '@clowdy/components/Text';
import { Folder } from '@clowdy/icons/14';

import { PathText } from '../../shared/PathText';
import { ProjectIcon } from '../../shared/ProjectIcon';
import { useProjectState, useProjectUi } from '../../stores';
import { currentFolder } from './currentFolder';
import styles from './InfoTab.module.css';

import type { ReactNode } from 'react';

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

/** The panel's Info tab: what the window is working on, as a short list. */
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

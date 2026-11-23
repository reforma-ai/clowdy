import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Folder, Version } from '@clowdy/icons/14';

import { PathText } from '../../shared/PathText';
import { ProjectIcon } from '../../shared/ProjectIcon';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { useFolderGit } from '../openWith';
import { openManageWorktrees } from '../worktrees';
import { currentPlace } from './currentPlace';
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

/**
 * The panel's Info tab: what the window is working on, as a short list: the project, its folder, the worktree of the open chat when it works in one, and the branch that is
 * checked out in the place (the worktree's own, which an agent may have switched). The Worktree row has a Manage button, which opens the dialog of the project's worktrees on
 * the folder; a chat in the folder's own checkout has no such row, and the Files tab's bar is its way in.
 */
export function InfoTab() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const { folder, workspace } = currentPlace(project, ui);
    const git = useFolderGit(project.id, folder.id, workspace);

    return (
        <dl className={ styles.info }>
            <InfoRow icon={ <ProjectIcon project={ project.project } /> } label="Project">
                <Text truncate>{ project.project.name }</Text>
            </InfoRow>
            <InfoRow icon={ <Folder aria-hidden="true" /> } label="Folder">
                <PathText path={ folder.path } />
            </InfoRow>
            { workspace && (
                <InfoRow icon={ <Folder aria-hidden="true" /> } label="Worktree">
                    <PathText path={ workspace.path } />
                    <Button
                        variant="filling"
                        color="secondary"
                        size="xs"
                        className={ styles.manage }
                        tooltip="Manage worktrees"
                        aria-label="Manage worktrees"
                        onPress={ () => openManageWorktrees({ root, projectId: project.id, folderId: folder.id }) }
                    >
                        Manage
                    </Button>
                </InfoRow>
            ) }
            { git?.branch && (
                <InfoRow icon={ <Version aria-hidden="true" /> } label="Branch">
                    <Text truncate title={ git.detached ? 'Detached HEAD' : undefined }>{ git.branch }</Text>
                </InfoRow>
            ) }
        </dl>
    );
}

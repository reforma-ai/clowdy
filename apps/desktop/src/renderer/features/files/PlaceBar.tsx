import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Folder, Version } from '@clowdy/icons/14';
import { folderNames } from '@clowdy/protocol';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState, useRootStore } from '../../stores';
import { placePath, type Place } from '../sidePanel/currentPlace';
import { openManageWorktrees } from '../worktrees';
import styles from './PlaceBar.module.css';

import type { FolderGit } from '../openWith';

/**
 * What the bar names, or `undefined` when there is nothing to name yet: the worktree's branch, or `<folder> · <branch>` for the folder's own checkout (the folder's short name,
 * the one the sidebar's group has). The branch is the live one (`useFolderGit`), so nothing is named until git has answered, and a folder that is no repository has none.
 * On a detached HEAD the branch is a short hash, said as such. A worktree that was made and is gone has no branch to read: it is named by the one it was made on.
 */
export function placeLabel(place: Place, folderName: string, git: FolderGit | undefined): string | undefined {
    const { workspace } = place;

    if (workspace && git?.gone) return workspace.branch ?? 'Worktree';

    if (git?.branch === undefined) return undefined;

    const head = git.detached ? `Detached at ${ git.branch }` : git.branch;

    return workspace ? head : `${ folderName } · ${ head }`;
}

/**
 * The thin bar on top of the Files and Docs tabs: where the panel is. An icon, the branch of the worktree the open chat works in (or the folder and its branch, for the
 * folder's own checkout), and a Manage button; the name and the button both open the dialog of the project's worktrees on the place's folder. The place is the window's, so
 * to look at another folder or worktree the person starts or opens a chat there. It is above the file manager and not in it (`packages/file-manager` is Reforma's fork).
 */
export function PlaceBar({ place, git }: { place: Place; git: FolderGit | undefined }) {
    const root = useRootStore();
    const project = useProjectState();
    const { folders } = project.project;
    const label = placeLabel(place, folderNames(folders)[folders.findIndex(folder => folder.id === place.folder.id)] ?? place.folder.path, git);

    if (label === undefined) return null;

    const manage = () => openManageWorktrees({ root, projectId: project.id, folderId: place.folder.id });

    return (
        <div className={ styles.bar } data-place-bar="">
            <Button
                variant="filling"
                color="secondary"
                size="xs"
                truncate
                className={ styles.place }
                tooltip={ git?.gone ? 'This worktree no longer exists' : tildePath(placePath(place), homeFolder.path) }
                onPress={ manage }
            >
                { place.workspace ? <Version aria-hidden="true" /> : <Folder aria-hidden="true" /> }
                <Text truncate>{ label }</Text>
            </Button>
            <Button variant="filling" color="secondary" size="xs" className={ styles.manage } tooltip="Manage worktrees" aria-label="Manage worktrees" onPress={ manage }>
                Manage
            </Button>
        </div>
    );
}

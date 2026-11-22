import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Folder } from '@clowdy/icons/14';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState } from '../../stores';
import { canOpenPaths, OpenWithMenu, useFolderGit, useFolderRepair, type FolderGit, type OpenTarget } from '../openWith';
import styles from './ChatFolder.module.css';
import { FolderTrigger } from './DraftFolderSelect';

import type { ProjectFolder } from '@clowdy/protocol';

export interface ChatFolderProps {
    name: string;
    folder: ProjectFolder;
    /** The folder is gone from the disk. */
    missing: boolean;
}

/** The branch that is checked out, in the muted type of the line: its name, or the short hash of a detached HEAD. Nothing for a folder that is not a repository. */
function Branch({ git }: { git: FolderGit | undefined }) {
    if (!git?.branch) return null;

    return <Text truncate className={ styles.branch } title={ git.detached ? 'Detached HEAD' : 'Branch' }>{ git.branch }</Text>;
}

/**
 * The folder a chat works in, in the place the new-chat page's select (`DraftFolderSelect`) had it, and the same size and name. In the desktop app it is the
 * same pill, and a press opens the menu of the folder (`OpenWithMenu`: Open in Files, the file manager, the editor and the terminal, each with the program's own
 * icon, GitHub when the folder is a GitHub repository, and Copy path), and the pill tells the path on hover, or that the folder is gone from the disk, when
 * the items are off. The branch that is checked out stands after the name. Anywhere else, a page in a browser, it is read only: no plate and no chevron, since
 * the folder of a chat never changes and there is nothing to open it in.
 */
export function ChatFolder({ name, folder, missing }: ChatFolderProps) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id);
    const repair = useFolderRepair(folder, missing);
    const title = missing ? 'This folder no longer exists' : tildePath(folder.path, homeFolder.path);

    if (!canOpenPaths()) {
        return (
            <>
                <div role="group" aria-label="Folder" className={ styles.folder } data-missing={ missing || undefined } title={ title }>
                    <Folder aria-hidden="true" />
                    <Text truncate>{ name }</Text>
                </div>
                <Branch git={ git } />
            </>
        );
    }

    const target: OpenTarget = { projectId: project.id, folder, path: folder.path, relative: '', kind: 'directory' };

    return (
        <>
            <MenuTrigger>
                <FolderTrigger name={ name } tooltip={ title } missing={ missing } />
                <Popover placement="bottom start" spacing="xs">
                    <OpenWithMenu target={ target } missing={ missing } repair={ repair } git={ git } aria-label="Open folder" />
                </Popover>
            </MenuTrigger>
            <Branch git={ git } />
        </>
    );
}

import { Button } from '@clowdy/components/Button';
import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { cn } from '@clowdy/lib';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState } from '../../stores';
import { canOpenPaths, OpenWithMenu, useFolderGit, type OpenTarget } from '../openWith';
import styles from './AgentList.module.css';

import type { ProjectFolder } from '@clowdy/protocol';

/** The menu of a group's folder: what is under the message box when a chat works in it (`ChatFolder`). It reads the folder's git once it is open, and not for each heading on the list. */
function GroupFolderMenu({ folder, missing }: { folder: ProjectFolder; missing: boolean }) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id);
    const target: OpenTarget = { projectId: project.id, folder, path: folder.path, relative: '', kind: 'directory' };

    return <OpenWithMenu target={ target } missing={ missing } git={ git } aria-label="Open folder" />;
}

/**
 * The name on the heading of a folder's group. In the desktop app a press on it opens the menu of the folder, the same as the folder under the message box has (Open in Files,
 * Copy path, Open in…), and the name tells the path on hover, or that the folder is gone from the disk; the name has the plate of an `xs` button, the chevron's size, on hover to say it can be pressed. Anywhere else,
 * a page in a browser, there is nothing to open the folder in, and the name is only a label.
 */
export function GroupFolderName({ name, folder, missing }: { name: string; folder: ProjectFolder; missing: boolean }) {
    if (!canOpenPaths()) return <span className={ cn(styles.title, styles.groupPlainName) }>{ name }</span>;

    return (
        <MenuTrigger>
            <Button
                variant="filling"
                color="inherit"
                size="xs"
                truncate
                className={ styles.groupName }
                aria-label={ `Folder: ${ name }` }
                tooltip={ missing ? 'This folder no longer exists' : tildePath(folder.path, homeFolder.path) }
                preventFocusOnPress
            >
                <span className={ styles.title }>{ name }</span>
            </Button>
            <Popover placement="bottom start" spacing="xs">
                <GroupFolderMenu folder={ folder } missing={ missing } />
            </Popover>
        </MenuTrigger>
    );
}

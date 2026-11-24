import { Button } from '@clowdy/components/Button';
import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { cn } from '@clowdy/lib';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState, useRootStore } from '../../stores';
import { canOpenPaths, type OpenTarget, OpenWithMenu, useFolderGit, useFolderRepair } from '../openWith';
import { openManageWorktrees } from '../worktrees';
import styles from './AgentList.module.css';

import type { ProjectFolder } from '@clowdy/protocol';

/**
 * The menu of a group's folder: New chat, the folder actions shared with `ChatFolder`, and `Manage worktrees…` last, under a separator. That item is always there, from
 * the first frame: it opens the dialog of the whole project, which has a group for each of its repositories and says so when none of its folders is one, so it needs no word from
 * the folder's git (which the menu reads as it opens, for the GitHub link, and which would have the item come in late and shift the menu). It is for a folder that is gone too.
 */
function GroupFolderMenu({
    folder,
    missing,
    onNewChat,
}: {
    folder: ProjectFolder;
    missing: boolean;
    onNewChat: () => void;
}) {
    const root = useRootStore();
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id);
    const repair = useFolderRepair(folder, missing);
    const target: OpenTarget = { projectId: project.id, folder, path: folder.path, relative: '', kind: 'directory' };

    return (
        <OpenWithMenu
            target={target}
            missing={missing}
            repair={repair}
            git={git}
            onNewChat={onNewChat}
            onManageWorktrees={() => openManageWorktrees({ root, projectId: project.id, folderId: folder.id })}
            aria-label="Open folder"
        />
    );
}

/**
 * The name on the heading of a folder's group. In the desktop app it opens the folder's menu and shows the path on hover, or says the folder is gone.
 * The selected chat stays open until the person chooses New chat. With no desktop bridge, the name is a label.
 */
export function GroupFolderName({
    name,
    folder,
    missing,
    onNewChat,
}: {
    name: string;
    folder: ProjectFolder;
    missing: boolean;
    onNewChat: () => void;
}) {
    if (!canOpenPaths()) return <span className={cn(styles.title, styles.groupPlainName)}>{name}</span>;

    return (
        <MenuTrigger>
            <Button
                variant="filling"
                color="inherit"
                size="xs"
                truncate
                className={styles.groupName}
                aria-label={`Folder: ${name}`}
                tooltip={missing ? 'This folder no longer exists' : tildePath(folder.path, homeFolder.path)}
                preventFocusOnPress
            >
                <span className={styles.title}>{name}</span>
            </Button>
            <Popover placement="bottom start" spacing="xs">
                <GroupFolderMenu folder={folder} missing={missing} onNewChat={onNewChat} />
            </Popover>
        </MenuTrigger>
    );
}

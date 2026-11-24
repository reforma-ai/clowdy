import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Folder } from '@clowdy/icons/14';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState } from '../../stores';
import {
    canOpenPaths,
    type FolderGit,
    type OpenTarget,
    OpenWithMenu,
    useFolderGit,
    useFolderRepair,
} from '../openWith';
import styles from './ChatFolder.module.css';
import { FolderTrigger } from './DraftFolderSelect';
import { WorkspaceLabel } from './WorkspaceChips';

import type { ChatWorkspace, ProjectFolder } from '@clowdy/protocol';

export interface FolderPillProps {
    name: string;
    folder: ProjectFolder;
    /** The folder is gone from the disk. */
    missing: boolean;
    /** What git says where the pill opens its menu (the link to GitHub names the branch). */
    git: FolderGit | undefined;
    /** Where the menu acts: the worktree of a chat that works in one. The folder's own checkout when absent. */
    workspace?: ChatWorkspace;
}

/**
 * The folder a chat works in, in the place the new-chat page's select (`DraftFolderSelect`) had it, and the same size and name. In the desktop app it is the
 * same pill, and a press opens the menu of the folder (`OpenWithMenu`: Open in Files, the file manager, the editor and the terminal, each with the program's own
 * icon, GitHub when the folder is a GitHub repository, and Copy path), and the pill tells the path on hover, or that the folder is gone from the disk, when
 * the items are off. Anywhere else, a page in a browser, it is read only: no plate and no chevron, since the folder of a chat never changes and there is nothing to open it in.
 * A chat in a worktree has the menu act on the worktree: its path is what the pill tells and the menu copies or opens.
 */
export function FolderPill({ name, folder, missing, git, workspace }: FolderPillProps) {
    const project = useProjectState();
    const path = workspace?.path ?? folder.path;
    // A worktree that is gone is not what Locate and Remove from project put right: they act on the folder, which is there.
    const repair = useFolderRepair(folder, missing && workspace === undefined);
    const title = missing ? 'This folder no longer exists' : tildePath(path, homeFolder.path);

    if (!canOpenPaths()) {
        return (
            <div
                role="group"
                aria-label="Folder"
                className={styles.folder}
                data-missing={missing || undefined}
                title={title}
            >
                <Folder aria-hidden="true" />
                <Text truncate>{name}</Text>
            </div>
        );
    }

    const target: OpenTarget = {
        projectId: project.id,
        folder,
        path,
        relative: '',
        kind: 'directory',
        ...(workspace && { workspace }),
    };

    return (
        <MenuTrigger>
            <FolderTrigger name={name} tooltip={title} missing={missing} />
            <Popover placement="bottom start" spacing="xs">
                <OpenWithMenu target={target} missing={missing} repair={repair} git={git} aria-label="Open folder" />
            </Popover>
        </MenuTrigger>
    );
}

export interface ChatFolderProps {
    name: string;
    folder: ProjectFolder;
    /** The folder is gone from the disk. */
    missing: boolean;
    /** The worktree the chat works in, if it does. */
    workspace?: ChatWorkspace;
    /** Whether to show the folder alongside the workspace. */
    showFolder?: boolean;
}

/**
 * The line under the message box of a chat that has started, read only: its folder (`FolderPill`) and one label (`WorkspaceLabel`) for where it works: the branch the tree has
 * checked out now, with `Worktree` before it for a chat in a worktree, as the new-chat page's control (`WorkspaceChips`) had it. The branch is read live, with the folder's `git` (see `useFolderGit`): an agent may switch
 * branches in a worktree, so the name the chat was made with is not shown once the worktree exists. A worktree that is gone from the disk makes the folder pill the warning colour.
 */
export function ChatFolder({ name, folder, missing, workspace, showFolder = true }: ChatFolderProps) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id, workspace);

    return (
        <>
            {showFolder && (
                <FolderPill
                    name={name}
                    folder={folder}
                    missing={missing || git?.gone === true}
                    git={git}
                    workspace={workspace}
                />
            )}
            <WorkspaceLabel worktree={workspace?.path} git={git} />
        </>
    );
}

/** The folder of a new chat in a project of one folder: nothing to pick, so the pill only says where the chat will work, as the chat's own does. */
export function DraftFolder({ name, folder, missing }: Omit<ChatFolderProps, 'workspace'>) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id);

    return <FolderPill name={name} folder={folder} missing={missing} git={git} />;
}

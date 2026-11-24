import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Folder, Split, Version } from '@clowdy/icons/14';

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
import { ChipTrigger } from './ChipTrigger';
import { FolderTrigger } from './DraftFolderSelect';

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

/** The current place of an existing chat; its menu opens or copies that place, never changes it. */
export function ChatFolder({ name, folder, missing, workspace, showFolder = true }: ChatFolderProps) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id, workspace);
    const gone = missing || git?.gone === true;
    const path = workspace?.path ?? folder.path;
    const repair = useFolderRepair(folder, gone && workspace === undefined);
    const branch = git?.branch;
    const place = [workspace ? 'Worktree' : undefined, branch].filter(Boolean).join(' ');
    // A non-git folder still needs a name when it is the project's only folder.
    const label = [showFolder || !place ? name : undefined, place].filter(Boolean).join(' · ');
    const detail = branch ? (git?.detached ? `detached at ${branch}` : `branch ${branch}`) : undefined;
    const ariaLabel = `Current place: ${[showFolder || !place ? name : undefined, workspace ? 'Worktree' : undefined, detail].filter(Boolean).join(', ')}`;
    const title = [
        tildePath(path, homeFolder.path),
        gone ? 'This folder no longer exists' : undefined,
        git?.detached ? 'Detached HEAD' : undefined,
    ]
        .filter(Boolean)
        .join('\n');
    const icon = workspace ? (
        <Split aria-hidden="true" />
    ) : branch ? (
        <Version aria-hidden="true" />
    ) : (
        <Folder aria-hidden="true" />
    );

    if (!canOpenPaths()) {
        return (
            <div
                role="group"
                aria-label={ariaLabel}
                className={styles.folder}
                data-missing={gone || undefined}
                title={title}
            >
                {icon}
                <Text truncate>{label}</Text>
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
            <ChipTrigger icon={icon} label={label} aria-label={ariaLabel} tooltip={title} missing={gone} />
            <Popover placement="bottom start" spacing="xs">
                <OpenWithMenu target={target} missing={gone} repair={repair} git={git} aria-label="Open folder" />
            </Popover>
        </MenuTrigger>
    );
}

/** The folder of a new chat in a project of one folder: nothing to pick, so the pill only says where the chat will work, as the chat's own does. */
export function DraftFolder({ name, folder, missing }: Omit<ChatFolderProps, 'workspace'>) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id);

    return <FolderPill name={name} folder={folder} missing={missing} git={git} />;
}

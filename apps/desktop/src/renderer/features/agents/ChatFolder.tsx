import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Folder, Version } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState, useProjectUi } from '../../stores';
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
import { WorkspaceLabel } from './WorkspaceChips';

import type { ChatWorkspace, ProjectFolder } from '@clowdy/protocol';

interface FolderPillProps {
    name: string;
    folder: ProjectFolder;
    /** The folder is gone from the disk. */
    missing: boolean;
    /** What git says where the pill opens its menu (the link to GitHub names the branch). */
    git: FolderGit | undefined;
    /** In a chat that has started, show the checkout and offer to start a chat there. */
    checkout?: { workspace?: ChatWorkspace; onNewChat: () => void };
}

/** One label for the chat's place, with actions for its checkout in the desktop app. */
function FolderPill({ name, folder, missing, git, checkout }: FolderPillProps) {
    const project = useProjectState();
    const workspace = checkout?.workspace;
    const path = workspace?.path ?? folder.path;
    const branch = checkout ? git?.branch : undefined;
    // A worktree that is gone is not what Locate and Remove from project put right: they act on the folder, which is there.
    const repair = useFolderRepair(folder, missing && workspace === undefined);
    const gone = workspace ? 'This worktree no longer exists' : 'This folder no longer exists';
    const title = missing
        ? gone
        : `${tildePath(path, homeFolder.path)}${branch && git?.detached ? '\nDetached HEAD' : ''}`;
    const label = [
        `Folder: ${name}`,
        workspace && 'worktree',
        branch && (git?.detached ? `detached at ${branch}` : `branch ${branch}`),
    ]
        .filter(Boolean)
        .join(', ');
    const detail = (workspace || branch) && (
        <span className={styles.checkout}>
            <Version aria-hidden="true" />
            <Text truncate color="secondary">
                {workspace ? ['Worktree', branch].filter(Boolean).join(' ') : branch}
            </Text>
        </span>
    );

    if (!canOpenPaths()) {
        return (
            <div
                role="group"
                aria-label={checkout ? label : 'Folder'}
                className={styles.folder}
                data-missing={missing || undefined}
                data-detail={detail ? true : undefined}
                title={title}
            >
                <Folder aria-hidden="true" />
                <Text truncate>{name}</Text>
                {detail}
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
            <ChipTrigger
                icon={<Folder aria-hidden="true" />}
                label={name}
                detail={detail}
                aria-label={label}
                tooltip={title}
                missing={missing}
            />
            <Popover placement="bottom start" spacing="xs">
                <OpenWithMenu
                    target={target}
                    missing={missing}
                    repair={repair}
                    git={git}
                    onNewChat={checkout?.onNewChat}
                    aria-label={workspace ? 'Worktree actions' : 'Open folder'}
                />
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

/** The chat's folder and current branch share the menu of the checkout it uses. */
export function ChatFolder({ name, folder, missing, workspace, showFolder = true }: ChatFolderProps) {
    const project = useProjectState();
    const ui = useProjectUi();
    const git = useFolderGit(project.id, folder.id, workspace);
    const onNewChat = () =>
        ui.openDraft(
            [],
            folder.id === mainFolder(project.project).id ? null : folder.id,
            workspace ? { mode: 'existing', path: workspace.path } : null
        );

    return showFolder || workspace ? (
        <FolderPill
            name={name}
            folder={folder}
            missing={missing || git?.gone === true}
            git={git}
            checkout={{ workspace, onNewChat }}
        />
    ) : (
        <WorkspaceLabel worktree={undefined} git={git} />
    );
}

/** The folder of a new chat in a project of one folder: nothing to pick, so the pill only says where the chat will work, as the chat's own does. */
export function DraftFolder({ name, folder, missing }: Omit<ChatFolderProps, 'workspace'>) {
    const project = useProjectState();
    const git = useFolderGit(project.id, folder.id);

    return <FolderPill name={name} folder={folder} missing={missing} git={git} />;
}

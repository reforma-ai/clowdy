import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Folder, Split, Version } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState, useProjectUi } from '../../stores';
import { canOpenPaths, type OpenTarget, OpenWithMenu, useFolderGit, useFolderRepair } from '../openWith';
import styles from './ChatFolder.module.css';
import { ChipTrigger } from './ChipTrigger';

import type { ChatWorkspace, ProjectFolder } from '@clowdy/protocol';

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
    const ui = useProjectUi();
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
        gone ? (workspace ? 'This worktree no longer exists' : 'This folder no longer exists') : undefined,
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
                <OpenWithMenu
                    target={target}
                    missing={gone}
                    repair={repair}
                    git={git}
                    onNewChat={() =>
                        ui.openDraft(
                            [],
                            folder.id === mainFolder(project.project).id ? null : folder.id,
                            workspace ? { mode: 'existing', path: workspace.path } : null
                        )
                    }
                    aria-label={workspace ? 'Worktree actions' : 'Open folder'}
                />
            </Popover>
        </MenuTrigger>
    );
}

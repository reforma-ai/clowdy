import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Folder, Version, WorktreeFolder } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { canOpenPaths, type OpenTarget, OpenWithMenu, useFolderGit, useFolderRepair } from '../openWith';
import { worktreeMenuExtras } from '../worktrees/worktreeMenuExtras';
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

/** The current place of an existing chat, with path actions and guarded worktree management. */
export function ChatFolder({ name, folder, missing, workspace, showFolder = true }: ChatFolderProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const git = useFolderGit(project.id, folder.id, workspace);
    const gone = missing || git?.gone === true;
    const path = workspace?.path ?? folder.path;
    const repair = useFolderRepair(folder, gone && workspace === undefined);
    const branch = git?.branch;
    const place = branch ?? (workspace ? 'Worktree' : undefined);
    // A non-git folder still needs a name when it is the project's only folder.
    const label = [showFolder || !place ? name : undefined, place].filter(Boolean).join(', ');
    const detail = branch ? (git?.detached ? `detached at ${branch}` : `branch ${branch}`) : undefined;
    const ariaLabel = `Current place: ${[showFolder || !place ? name : undefined, workspace ? 'Worktree' : undefined, detail].filter(Boolean).join(', ')}`;
    const pathLabel = tildePath(path, homeFolder.path);
    const note = gone ? (workspace ? 'This worktree no longer exists' : 'This folder no longer exists') : undefined;
    const tooltip = (
        <div className={styles.tooltip}>
            <span>{workspace ? 'Working in worktree' : 'Working in project folder'}</span>
            <span className={styles.tooltipPath}>{pathLabel}</span>
            {note && <span>{note}</span>}
            {git?.detached && <span>Detached HEAD</span>}
        </div>
    );
    const icon = workspace ? (
        <WorktreeFolder aria-hidden="true" />
    ) : branch ? (
        <Version aria-hidden="true" />
    ) : (
        <Folder aria-hidden="true" />
    );

    if (!canOpenPaths()) {
        return (
            <Tooltip content={tooltip}>
                <div role="img" aria-label={ariaLabel} className={styles.folder} data-missing={gone || undefined}>
                    {icon}
                    <Text truncate>{label}</Text>
                </div>
            </Tooltip>
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
                icon={icon}
                folder={showFolder && place ? name : undefined}
                label={place ?? name}
                aria-label={ariaLabel}
                tooltip={tooltip}
                missing={gone}
            />
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
                    extra={
                        workspace && workspace.ready
                            ? worktreeMenuExtras({
                                  root,
                                  projectId: project.id,
                                  folderId: folder.id,
                                  path,
                                  workspaceId: workspace.id,
                                  previewLabel: branch,
                              })
                            : undefined
                    }
                    aria-label={workspace ? 'Worktree actions' : 'Open folder'}
                />
            </Popover>
        </MenuTrigger>
    );
}

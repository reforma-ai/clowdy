import { For } from '@clowdy/components/For';
import { Menu, MenuItem, MenuSeparator, SubmenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Copy, Follow, NewChat, Trash } from '@clowdy/icons/14';
import { ChevronRight } from '@clowdy/icons/8';

import { worktreeLabel } from '../agents/workspaceChoice';
import { actionIcon, chosenPrograms, openActions, openEffects, useFolderGit, useOpenApps } from '../openWith';
import { removeHint } from './worktreeView';

import type { FolderWorktrees, ProjectFolder, ProjectId, WorktreeInfo } from '@clowdy/protocol';
import type { OpenAction, OpenTarget } from '../openWith';

const NEW_CHAT = 'newChat';
const OPEN_IN = 'openIn';
const REMOVE = 'remove';

export interface WorktreeMenuProps {
    projectId: ProjectId;
    group: FolderWorktrees;
    folder: ProjectFolder;
    worktree: WorktreeInfo;
    onNewChat: (folder: ProjectFolder, worktree: WorktreeInfo) => void;
    onRemove: (group: FolderWorktrees, worktree: WorktreeInfo) => void;
    /** Called when an item is pressed, before it runs: a menu that is not in a `MenuTrigger` (the row's right-click) shuts itself here. */
    onClose?: () => void;
}

/**
 * The menu of a row's More button, to go inside a `Popover`: a new chat in the worktree, the copy of its path, `Open in…` (a submenu of the programs of the computer that open
 * it: the editor, the file manager, the terminal, GitHub), and, under a separator, Remove, which the folder's own checkout does not have. The dialog covers the window's places,
 * so it has no Open in Files and no Open in Terminal, which would act behind it, and so it is built here from `openActions` and not as `OpenWithMenu`, which offers them. It reads
 * the folder's git, for the GitHub link, once it is open (a popover builds its content then), and not for every row on the list. A Remove that is off says why under its name.
 */
export function WorktreeMenu({ projectId, group, folder, worktree, onNewChat, onRemove, onClose }: WorktreeMenuProps) {
    const apps = useOpenApps();
    const folderGit = useFolderGit(projectId, folder.id);
    const git = folderGit && { remoteUrl: folderGit.remoteUrl, ...(worktree.branch === undefined ? { detached: true } : { branch: worktree.branch }) };
    const target: OpenTarget = { projectId, folder, path: worktree.path, relative: '', kind: 'directory' };
    const actions = openActions({ target, programs: chosenPrograms(apps), git, missing: worktree.missing, effects: openEffects });
    const copy = actions.find(action => action.id === 'copyPath');
    const outside = actions.filter(action => action.group === 'outside');
    const hint = removeHint(worktree);
    const label = worktreeLabel(worktree);
    const run = (key: string) => {
        onClose?.();

        if (key === NEW_CHAT) onNewChat(folder, worktree);
        else if (key === REMOVE) onRemove(group, worktree);
        else actions.find(action => action.id === key)?.run();
    };
    const item = (action: OpenAction) => (
        <MenuItem key={ action.id } id={ action.id } icon={ actionIcon(action) } textValue={ action.label } isDisabled={ action.isDisabled }>{ action.label }</MenuItem>
    );

    return (
        <PopoverScroll>
            <Menu aria-label={ `Actions for ${ label }` } size="sm" onAction={ key => run(String(key)) }>
                <MenuItem id={ NEW_CHAT } icon={ <NewChat aria-hidden="true" /> } textValue="New chat" isDisabled={ worktree.missing }>New chat</MenuItem>
                { copy && <MenuItem id={ copy.id } icon={ actionIcon(copy) } textValue={ copy.label }>{ copy.label }</MenuItem> }
                { outside.length > 0 && (
                    <SubmenuTrigger>
                        <MenuItem id={ OPEN_IN } icon={ <Follow aria-hidden="true" /> } textValue="Open in…" isDisabled={ outside.every(action => action.isDisabled) } endAffix={ <ChevronRight /> }>Open in…</MenuItem>
                        <Popover spacing="xs">
                            <Menu aria-label="Open in" size="sm" onAction={ key => run(String(key)) }>
                                <For each={ outside }>{ item }</For>
                            </Menu>
                        </Popover>
                    </SubmenuTrigger>
                ) }
                { !worktree.main && (
                    <>
                        <MenuSeparator />
                        <MenuItem id={ REMOVE } icon={ <Trash aria-hidden="true" /> } textValue={ worktree.missing ? 'Remove record' : 'Remove' } isDanger isDisabled={ hint !== undefined } stacked={ hint !== undefined } description={ hint }>
                            { worktree.missing ? 'Remove record…' : 'Remove…' }
                        </MenuItem>
                    </>
                ) }
            </Menu>
        </PopoverScroll>
    );
}

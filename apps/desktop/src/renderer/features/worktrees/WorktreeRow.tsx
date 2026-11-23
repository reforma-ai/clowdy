import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Folder, Follow, NewChat, Trash, Version } from '@clowdy/icons/14';
import { useId } from 'react';

import { PathText } from '../../shared/PathText';
import { Unavailable } from '../../shared/Unavailable';
import { worktreeLabel } from '../agents/workspaceChoice';
import { canOpenPaths, OpenWithMenu, useFolderGit } from '../openWith';
import styles from './ManageWorktrees.module.css';
import { changesLabel, lockTip, mergedMark, removeHint } from './worktreeView';

import type { FolderWorktrees, ProjectFolder, ProjectId, WorktreeChat, WorktreeInfo } from '@clowdy/protocol';
import type { OpenTarget } from '../openWith';

/** What a row asks its dialog to do: the dialog closes itself for the ones that leave it. */
export interface WorktreeRowActions {
    /** A new-chat draft in the worktree, or in the folder's own checkout for the first row of a group. */
    onNewChat: (folder: ProjectFolder, worktree: WorktreeInfo) => void;
    onOpenChat: (chat: WorktreeChat) => void;
    /** Absent: Remove is drawn and cannot be pressed. */
    onRemove?: (group: FolderWorktrees, worktree: WorktreeInfo) => void;
}

/**
 * The menu of a row's Open button: the worktree's folder on the disk, in the project's folder it is a checkout of. It reads the folder's git, for the GitHub link, once it is
 * open, and not for every row on the list. The dialog covers the window's places, so the menu leaves out Open in Files and Open in Terminal, which would act behind it.
 */
function WorktreeOpenMenu({ projectId, folder, worktree }: { projectId: ProjectId; folder: ProjectFolder; worktree: WorktreeInfo }) {
    const folderGit = useFolderGit(projectId, folder.id);
    const git = folderGit && { remoteUrl: folderGit.remoteUrl, ...(worktree.branch === undefined ? { detached: true } : { branch: worktree.branch }) };
    const target: OpenTarget = { projectId, folder, path: worktree.path, relative: '', kind: 'directory' };

    return <OpenWithMenu target={ target } missing={ worktree.missing } git={ git } inApp={ false } aria-label="Open worktree" />;
}

interface WorktreeRowProps extends WorktreeRowActions {
    projectId: ProjectId;
    group: FolderWorktrees;
    folder: ProjectFolder;
    worktree: WorktreeInfo;
}

/**
 * One worktree of a folder, as git lists it: its branch (or the commit it is on), the marks that matter (the folder's own checkout, locked, gone from the disk), the path, how
 * many files are changed and whether its work is in the base, and the chats that work in it, archived ones too, each a button that opens it. At the end: the programs
 * that open it (`OpenWithMenu`), a new chat in it, and Remove, which the folder's own checkout does not have. A worktree whose folder is gone has no chat to start in it.
 */
export function WorktreeRow({ projectId, group, folder, worktree, onNewChat, onOpenChat, onRemove }: WorktreeRowProps) {
    const label = worktreeLabel(worktree);
    const merged = mergedMark(worktree);
    const newChat = worktree.main ? 'New chat in this folder' : 'New chat in this worktree';
    const hint = removeHint(worktree);

    return (
        <li className={ styles.row } data-worktree-path={ worktree.path } data-main={ worktree.main || undefined } data-missing={ worktree.missing || undefined }>
            <span className={ styles.icon }>{ worktree.main ? <Folder aria-hidden="true" /> : <Version aria-hidden="true" /> }</span>
            <span className={ styles.text }>
                <span className={ styles.title }>
                    <Text weight="medium" truncate>{ label }</Text>
                    { worktree.main && <Badge size="xs" textValue="Project checkout" tooltip="The folder itself, where a chat works without a worktree">Project checkout</Badge> }
                    { worktree.locked !== undefined && <Badge size="xs" textValue="Locked" tooltip={ lockTip(worktree.locked) }>Locked</Badge> }
                    { worktree.missing && <Badge size="xs" color="warning" textValue="Missing on disk" tooltip="Git lists it, but its folder is gone">Missing on disk</Badge> }
                </span>
                <PathText path={ worktree.path } variant="sm" color="secondary" />
                <span className={ styles.facts }>
                    { !worktree.missing && <Text variant="sm" color={ worktree.changes === 0 ? 'secondary' : 'default' }>{ changesLabel(worktree.changes) }</Text> }
                    { merged && <Badge size="xs" color={ merged.color } textValue={ merged.label } tooltip={ merged.tip }>{ merged.label }</Badge> }
                </span>
                { worktree.chats.length > 0 && (
                    <span className={ styles.chats } role="group" aria-label="Chats">
                        <For each={ worktree.chats }>
                            {chat => (
                                <Button key={ chat.id } variant="filling" color="secondary" size="xs" truncate className={ styles.chat } onPress={ () => onOpenChat(chat) }>
                                    <span className={ styles.chatTitle }>{ chat.title }</span>
                                    { chat.archived && <span className={ styles.archived }>Archived</span> }
                                </Button>
                            )}
                        </For>
                    </span>
                ) }
            </span>
            <span className={ styles.actions }>
                { canOpenPaths() && (
                    <MenuTrigger>
                        <Button variant="filling" color="secondary" size="sm" iconOnly aria-label={ `Open ${ label }` } tooltip="Open in…">
                            <Follow />
                        </Button>
                        <Popover placement="bottom end" spacing="xs">
                            <WorktreeOpenMenu projectId={ projectId } folder={ folder } worktree={ worktree } />
                        </Popover>
                    </MenuTrigger>
                ) }
                <Unavailable label={ `${ newChat }: ${ label }` } hint={ worktree.missing ? 'Its folder is gone from the disk' : undefined } placement="top">
                    <Button variant="filling" color="secondary" size="sm" iconOnly aria-label={ `${ newChat }: ${ label }` } tooltip={ worktree.missing ? undefined : newChat } isDisabled={ worktree.missing } onPress={ () => onNewChat(folder, worktree) }>
                        <NewChat />
                    </Button>
                </Unavailable>
                {/* Remove is wired by Stage 5 of `.briefback/worktree-followups/plan.md`: until `onRemove` is given it cannot be pressed, and a reason from the daemon keeps it off after. */}
                { !worktree.main && (
                    <Unavailable label={ `Remove ${ label }` } hint={ hint } placement="top">
                        <Button variant="filling" color="secondary" size="sm" iconOnly aria-label={ `Remove ${ label }` } tooltip={ hint === undefined ? 'Remove' : undefined } isDisabled={ onRemove === undefined || hint !== undefined } onPress={ () => onRemove?.(group, worktree) }>
                            <Trash />
                        </Button>
                    </Unavailable>
                ) }
            </span>
        </li>
    );
}

/** One folder of the project: its name, and its worktrees in a card, the folder's own checkout first. */
export function WorktreeGroup({ projectId, group, folder, ...actions }: Omit<WorktreeRowProps, 'worktree'>) {
    const headingId = useId();

    return (
        <section className={ styles.group } aria-labelledby={ headingId } data-folder-id={ group.folderId }>
            <Text as="h3" id={ headingId } variant="heading-5" truncate>{ group.name }</Text>
            <ul className={ styles.card }>
                <For each={ group.worktrees }>
                    {worktree => <WorktreeRow key={ worktree.path } projectId={ projectId } group={ group } folder={ folder } worktree={ worktree } { ...actions } />}
                </For>
            </ul>
        </section>
    );
}

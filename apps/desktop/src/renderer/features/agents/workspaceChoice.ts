import type { Chat, ChatWorkspaceChoice, FolderGit, GitWorktree } from '@clowdy/protocol';
import type { FolderRepository } from './useFolderRepository';

/** What the daemon says of a folder that is a repository (the part of `FolderGit` with branches and worktrees). */
export type Repository = Extract<FolderGit, { isRepository: true }>;

/** The folder's repository, once the daemon has said the folder is one. */
export function repositoryOf(repository: FolderRepository): Repository | undefined {
    return repository.status === 'ready' && repository.git.isRepository ? repository.git : undefined;
}

/** Whether two paths the daemon wrote name one place: a trailing separator does not count, and on Windows neither do the case or the kind of separator. */
export function samePath(a: string, b: string): boolean {
    const bare = (path: string) => path.replace(/[\\/]+$/, '');

    if (/^[a-z]:[\\/]/i.test(a) && /^[a-z]:[\\/]/i.test(b))
        return bare(a).replaceAll('\\', '/').toLowerCase() === bare(b).replaceAll('\\', '/').toLowerCase();

    return bare(a) === bare(b);
}

/** The worktrees a chat may be sent into: every one of the folder's but the folder's own checkout, which is Project checkout. */
export function pickableWorktrees(repository: Repository): GitWorktree[] {
    return repository.worktrees.filter(worktree => !worktree.main);
}

/** How a worktree is named in a list: its branch, or on a detached HEAD the commit it is on. */
export function worktreeLabel(worktree: { branch?: string; head?: string }): string {
    return worktree.branch ?? (worktree.head ? `Detached at ${worktree.head}` : 'Detached HEAD');
}

/** Name a worktree alongside its folder without repeating a branch's existing folder prefix. */
export function worktreeGroupLabel(folder: string, worktree: { branch?: string; head?: string }): string {
    const label = worktreeLabel(worktree);
    return label.startsWith(`${folder}/`) ? label : `${folder}/${label}`;
}

/**
 * What the new chat is made with: the person's choice, as far as the folder's repository allows it, and `undefined` for Project checkout. The daemon refuses a worktree of a
 * folder that is no repository, a base that is no ref, and a path that is no worktree of the folder, so a choice that the read does not bear out (nothing read yet, the read
 * failed, the folder is no repository, the worktree is gone since, the folder has no commit to start from) is never sent. A chosen base is validated by the daemon, since the listing may be stale.
 * A branch of the folder's own checkout (`main`) is kept while the folder is not on it: the branch it is on already is no change, so nothing is sent. Whether the branch is still there
 * is the daemon's to say when the chat is made (`There is no branch called x`): the list it was picked from is only as old as the popover.
 */
export function effectiveChoice(
    choice: ChatWorkspaceChoice | null,
    repository: FolderRepository
): ChatWorkspaceChoice | undefined {
    const git = repositoryOf(repository);

    if (!choice || !git) return undefined;

    if (choice.mode === 'main') return choice.branch === git.branch && !git.detached ? undefined : { ...choice };

    if (choice.mode === 'existing') {
        const worktree = pickableWorktrees(git).find(candidate => samePath(candidate.path, choice.path));

        return worktree && { mode: 'existing', path: worktree.path };
    }

    const base = choice.base;

    if (base === undefined && git.defaultBranch === undefined) return undefined;

    return base === undefined ? { mode: 'new' } : { mode: 'new', base };
}

/** The chats that work in the worktree at `path`, as the list shows chats: the ones the person made and has not put away (their threads share the worktree and are not named). */
export function chatsUsing(chats: Iterable<Chat>, path: string): Chat[] {
    return [...chats].filter(
        chat =>
            chat.workspace !== undefined &&
            chat.archivedAt === undefined &&
            chat.parentChatId === undefined &&
            samePath(chat.workspace.path, path)
    );
}

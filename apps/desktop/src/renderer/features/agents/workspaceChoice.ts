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

    if (/^[a-z]:[\\/]/i.test(a) && /^[a-z]:[\\/]/i.test(b)) return bare(a).replaceAll('\\', '/').toLowerCase() === bare(b).replaceAll('\\', '/').toLowerCase();

    return bare(a) === bare(b);
}

/** The worktrees a chat may be sent into: every one of the folder's but the folder's own checkout, which is Project checkout. */
export function pickableWorktrees(repository: Repository): GitWorktree[] {
    return repository.worktrees.filter(worktree => !worktree.main);
}

/** How a worktree is named in a list: its branch, or on a detached HEAD the commit it is on. */
export function worktreeLabel(worktree: Pick<GitWorktree, 'branch' | 'head'>): string {
    return worktree.branch ?? (worktree.head ? `Detached at ${ worktree.head }` : 'Detached HEAD');
}

/** Whether a ref may be a new worktree's base: one of the folder's branches, or the default branch (a short hash on a detached HEAD, which no branch has). */
const hasBase = (repository: Repository, base: string) => base === repository.defaultBranch || repository.branches.some(branch => branch.name === base);

/**
 * What the new chat is made with: the person's choice, as far as the folder's repository allows it, and `undefined` for Project checkout. The daemon refuses a worktree of a
 * folder that is no repository, a base that is no ref, and a path that is no worktree of the folder, so a choice that the read does not bear out (nothing read yet, the read
 * failed, the folder is no repository, the worktree is gone since, the folder has no commit to start from) is never sent. A base that has gone is dropped, which is the default one.
 */
export function effectiveChoice(choice: ChatWorkspaceChoice | null, repository: FolderRepository): ChatWorkspaceChoice | undefined {
    const git = repositoryOf(repository);

    if (!choice || !git) return undefined;

    if (choice.mode === 'existing') {
        const worktree = pickableWorktrees(git).find(candidate => samePath(candidate.path, choice.path));

        return worktree && { mode: 'existing', path: worktree.path };
    }

    const base = choice.base !== undefined && hasBase(git, choice.base) ? choice.base : undefined;

    if (base === undefined && git.defaultBranch === undefined) return undefined;

    return base === undefined ? { mode: 'new' } : { mode: 'new', base };
}

/** The chats that work in the worktree at `path`, as the list shows chats: the ones the person made and has not put away (their threads share the worktree and are not named). */
export function chatsUsing(chats: Iterable<Chat>, path: string): Chat[] {
    return [...chats].filter(chat => chat.workspace !== undefined && chat.archivedAt === undefined && chat.parentChatId === undefined && samePath(chat.workspace.path, path));
}

import { GIT_DISCARD_KEEP_DAYS } from '@clowdy/protocol';

import { chatFolder, orchestratorOf } from '../agents/agentTree';
import { chatPlace } from '../sidePanel/currentPlace';
import { splitPath } from './gitSummary';

import type { Chat, ChatId, GitChangedFile, GitChanges, GitScope, ProjectFolder, Run, RunId } from '@clowdy/protocol';

/** The scopes that list what is uncommitted, and so the only ones a file's changes are discarded from: the others (the branch, one commit) list what is committed, which a discard does not touch. */
const DISCARD_SCOPES: readonly GitScope[] = ['all', 'uncommitted'];

/** The mode git records for a submodule, as the first and the third part of a revision say it. */
const SUBMODULE_MODE = '160000';

/**
 * The files of the place whose changes may be discarded from the scope that is shown, by path: the files of the uncommitted list (`GitChanges` of the `uncommitted` scope, whichever scope is
 * shown, since in `all` a file may be edited and committed both) in `all` and `uncommitted`, and none in the others. A file with merge conflicts and a submodule are left out: the daemon refuses both
 * (`Resolve the conflict first`, `A submodule can't be discarded here`), so offering them would only be an action that must fail. What is offered is always the uncommitted entry of the file, the
 * one the dialog speaks of, which is not always the entry of the shown scope (a file renamed on the branch and edited since is a rename in `all` and an edit in the uncommitted list).
 */
export function discardableFiles(scope: GitScope, uncommitted: Extract<GitChanges, { isRepository: true }> | undefined): ReadonlyMap<string, GitChangedFile> {
    if (!uncommitted || !DISCARD_SCOPES.includes(scope)) return new Map();

    return new Map(uncommitted.files.filter((file) => {
        const [oldMode, , newMode] = file.revision.split(':');

        return file.kind !== 'conflicted' && oldMode !== SUBMODULE_MODE && newMode !== SUBMODULE_MODE;
    }).map(file => [file.path, file]));
}

/** What the confirmation says of one file. */
export interface DiscardWords {
    /** `Discard changes to <name>?`, or `Delete <name>?` for a file that git does not have in its last commit. */
    title: string;
    /** What happens: where the file goes, and that a copy is kept. Two sentences keep their periods; one phrase has none. */
    body: string;
}

/** The sentence that says a copy is kept, for a file whose copy is its own bytes: `of it` for a file that is deleted, `of what it holds now` for one that goes back. */
const kept = (about: string) => `A copy of ${ about } is kept for ${ GIT_DISCARD_KEEP_DAYS } days.`;

/**
 * What the confirmation says of a file, by what happens to it: a file the last commit has goes back to it (`Discard changes to price.ts?`), one it has not (a new file, staged or not) is deleted
 * (`Delete notes.md?`, in the words GitHub Desktop has for it), and a file that is deleted has nothing on the disk to keep a copy of, so the dialog does not promise one.
 */
export function discardWords(file: Pick<GitChangedFile, 'path' | 'kind' | 'untracked'>): DiscardWords {
    const { name } = splitPath(file.path);

    if (file.untracked) return { title: `Delete ${ name }?`, body: `The file is not in git. ${ kept('it') }` };

    if (file.kind === 'added') return { title: `Delete ${ name }?`, body: `The file was never committed. ${ kept('it') }` };

    if (file.kind === 'deleted') return { title: `Discard changes to ${ name }?`, body: 'The file comes back from the last commit' };

    if (file.kind === 'renamed') return { title: `Discard changes to ${ name }?`, body: `The rename is undone and the file goes back to the last commit. ${ kept('what it holds now') }` };

    return { title: `Discard changes to ${ name }?`, body: `The file goes back to the last commit. ${ kept('what it holds now') }` };
}

/** The warning the dialog carries while a chat works in the place: nothing for none. */
export function agentsWorkingWords(count: number): string | undefined {
    if (count <= 0) return undefined;

    return count === 1 ? 'An agent is working here' : `${ count } agents are working here`;
}

/** What the count of the chats working in a place reads of a project. */
interface ProjectChats {
    chats: ReadonlyMap<ChatId, Chat>;
    runs: ReadonlyMap<RunId, Run>;
    project: { folders: readonly ProjectFolder[] };
}

/**
 * How many chats work in a place right now: those whose orchestrator is writing, or keeps background work going that may (`running`, `waiting_background`), among the chats (threads too) of
 * the project that have the folder's checkout or the worktree as their place. A queued run, one that waits for the person and a finished one write nothing. This is what the renderer knows; the
 * daemon does not check (a chat's work is not its to stop), so the dialog says it and the person decides.
 */
export function agentsWorkingIn(project: ProjectChats, place: { folderId: string; workspaceId?: string }): number {
    const { folders } = project.project;
    let count = 0;

    for (const chat of project.chats.values()) {
        const status = orchestratorOf(chat, project.runs)?.status;

        if (status !== 'running' && status !== 'waiting_background') continue;

        const where = chatPlace(folders, chat, chatFolder(project.chats, folders, chat.id)?.folder);

        if (where.folder.id === place.folderId && where.workspace?.id === place.workspaceId) count++;
    }

    return count;
}

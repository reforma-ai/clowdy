import { FileSystemError } from '@clowdy/file-manager/provider';

import { createFixtureData, withFixtureWorkspace } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { TransportError, type ProjectFileSystem, type Transport } from './transport';

import type { FixtureCommitScript, FixtureMessageScript } from './fixtureGitWrites';


export type DaemonConfig =
    | { kind: 'daemon'; url: string; token: string }
    | { kind: 'fixtures'; timeline: boolean; worktree?: true; commit?: FixtureCommitScript; message?: FixtureMessageScript }
    | { kind: 'none' };

/** The value of a switch of the page's address when it is one of the words the switch knows. */
const oneOf = <T extends string>(value: string | null, words: readonly T[]): T | undefined => words.find(word => word === value);

/**
 * Where the UI gets its data, in order of precedence:
 * 1. `window.desktop.daemon`, which the desktop shell fills in;
 * 2. `?daemon=<url>&token=<token>` in the page URL;
 * 3. `?fixtures`, scripted data in memory (`?fixtures=static` leaves out the timed events, `&worktree` adds the chat that works in a dirty worktree, `?chat=c-9`, whose changes
 *    the side panel's Changes tab shows; `&commit=signing|hook|slow` and `&message=failed|slow` say how a commit and a request for its message end there, which the screenshots of the commit
 *    box use);
 * 4. nothing: the UI shows that it cannot reach a daemon.
 */
export function resolveDaemonConfig(search: string, bridge?: { url: string; token: string }): DaemonConfig {
    if (bridge) return { kind: 'daemon', ...bridge };

    const params = new URLSearchParams(search);
    const url = params.get('daemon');

    if (url) return { kind: 'daemon', url, token: params.get('token') ?? '' };

    if (params.has('fixtures')) {
        const commit = oneOf(params.get('commit'), ['signing', 'hook', 'slow'] as const);
        const message = oneOf(params.get('message'), ['failed', 'slow'] as const);

        return { kind: 'fixtures', timeline: params.get('fixtures') !== 'static', ...(params.has('worktree') && { worktree: true as const }), ...(commit && { commit }), ...(message && { message }) };
    }

    return { kind: 'none' };
}

const noDaemon = () => Promise.reject(new TransportError('No daemon is configured'));

/** A file system whose every request fails, as the daemon's would while it is out of reach. */
const noFiles = (): ProjectFileSystem => {
    const fail = () => Promise.reject(new FileSystemError('Unavailable', 'No daemon is configured'));

    return { list: fail, read: fail, write: fail, createDirectory: fail, move: fail, copy: fail, delete: fail };
};

/** Answers every request with a failure, so the UI shows its "cannot reach" screen like for any unreachable daemon. */
const unconfigured: Transport = {
    getRootSnapshot: noDaemon,
    getProjectSnapshot: noDaemon,
    getProjectsInfo: noDaemon,
    getFolderGit: noDaemon,
    getGitStatus: noDaemon,
    getGitChanges: noDaemon,
    getGitFile: noDaemon,
    commitGit: noDaemon,
    generateGitMessage: noDaemon,
    getProjectWorktrees: noDaemon,
    getGitPullRequest: noDaemon,
    getChatWorkspaceRemoval: noDaemon,
    subscribe: () => () => undefined,
    command: noDaemon,
    getItems: noDaemon,
    getTaskDetail: noDaemon,
    getTaskDetailByKey: noDaemon,
    getTaskComments: noDaemon,
    getArchivedTasks: noDaemon,
    getDocsTree: noDaemon,
    getProjectFiles: noDaemon,
    fileSystem: noFiles,
    uploadAttachment: noDaemon,
    getAttachment: noDaemon,
    deleteAttachment: noDaemon,
    getProjectIcon: noDaemon,
    getSkills: noDaemon,
    getAgents: noDaemon,
    getAgentModels: noDaemon,
    listTerminals: noDaemon,
    createTerminal: noDaemon,
    closeTerminal: noDaemon,
    openTerminal: (_id, handlers) => {
        handlers.onGone();

        return { write: () => false, resize: () => undefined, close: () => undefined };
    },
};

export function createTransport(config: DaemonConfig): Transport {
    if (config.kind === 'daemon') return new HttpTransport(config);

    return config.kind === 'fixtures'
        ? new FixtureTransport({ timeline: config.timeline, gitWrites: { commit: config.commit, message: config.message }, ...(config.worktree && { data: withFixtureWorkspace(createFixtureData()) }) })
        : unconfigured;
}

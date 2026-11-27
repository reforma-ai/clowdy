import { FileSystemError } from '@clowdy/file-manager/provider';

import { HttpTransport } from './httpTransport';
import { type ProjectFileSystem, type Transport, TransportError } from './transport';

export type DaemonConfig =
    | { kind: 'daemon'; url: string; token: string }
    /** The page's address, whose switches `fixtureOptions` (`./fixtures`) reads. */
    | { kind: 'fixtures'; search: string }
    | { kind: 'none' };

/**
 * Where the UI gets its data, in order of precedence:
 * 1. `window.desktop.daemon`, which the desktop shell fills in;
 * 2. `?daemon=<url>&token=<token>` in the page URL;
 * 3. in development only, `?fixtures`: scripted data in memory, with the switches `fixtureOptions` (`./fixtures`) reads;
 * 4. nothing: the UI shows that it cannot reach a daemon.
 */
export function resolveDaemonConfig(search: string, bridge?: { url: string; token: string }): DaemonConfig {
    if (bridge) return { kind: 'daemon', ...bridge };

    const params = new URLSearchParams(search);
    const url = params.get('daemon');

    if (url) return { kind: 'daemon', url, token: params.get('token') ?? '' };

    if (import.meta.env.DEV && params.has('fixtures')) return { kind: 'fixtures', search };

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
    getGitViewed: noDaemon,
    setGitViewed: noDaemon,
    clearGitViewed: noDaemon,
    commitGit: noDaemon,
    discardGit: noDaemon,
    generateGitMessage: noDaemon,
    fetchGit: noDaemon,
    pullGit: noDaemon,
    pushGit: noDaemon,
    syncGit: noDaemon,
    getGitCloneTarget: noDaemon,
    cloneGit: noDaemon,
    updateGit: noDaemon,
    abortGit: noDaemon,
    getGitBranches: noDaemon,
    deleteGitBranch: noDaemon,
    switchGitBranch: noDaemon,
    createGitBranch: noDaemon,
    branchMergeGit: noDaemon,
    getProjectWorktrees: noDaemon,
    getGitPullRequest: noDaemon,
    getGitBranchPullRequests: noDaemon,
    setGitPullRequestArchived: noDaemon,
    getChatWorkspaceRemoval: noDaemon,
    subscribe: () => () => undefined,
    command: noDaemon,
    getPromptSuggestion: noDaemon,
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
    getHealth: noDaemon,
    getPowerSettings: noDaemon,
    setSleepMode: noDaemon,
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

export async function createTransport(config: DaemonConfig): Promise<Transport> {
    if (config.kind === 'daemon') return new HttpTransport(config);

    // `import.meta.env.DEV` is `false` in the packaged app's build, which drops this branch and the fixture modules with it.
    if (import.meta.env.DEV && config.kind === 'fixtures') {
        const { createFixtureTransport, fixtureOptions } = await import('./fixtures');

        return createFixtureTransport(fixtureOptions(config.search));
    }

    return unconfigured;
}

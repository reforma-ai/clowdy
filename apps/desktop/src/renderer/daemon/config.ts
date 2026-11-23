import { FileSystemError } from '@clowdy/file-manager/provider';

import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { TransportError, type ProjectFileSystem, type Transport } from './transport';


export type DaemonConfig =
    | { kind: 'daemon'; url: string; token: string }
    | { kind: 'fixtures'; timeline: boolean }
    | { kind: 'none' };

/**
 * Where the UI gets its data, in order of precedence:
 * 1. `window.desktop.daemon`, which the desktop shell fills in;
 * 2. `?daemon=<url>&token=<token>` in the page URL;
 * 3. `?fixtures`, scripted data in memory (`?fixtures=static` leaves out the timed events);
 * 4. nothing: the UI shows that it cannot reach a daemon.
 */
export function resolveDaemonConfig(search: string, bridge?: { url: string; token: string }): DaemonConfig {
    if (bridge) return { kind: 'daemon', ...bridge };

    const params = new URLSearchParams(search);
    const url = params.get('daemon');

    if (url) return { kind: 'daemon', url, token: params.get('token') ?? '' };

    if (params.has('fixtures')) return { kind: 'fixtures', timeline: params.get('fixtures') !== 'static' };

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
    getProjectWorktrees: noDaemon,
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

    return config.kind === 'fixtures' ? new FixtureTransport({ timeline: config.timeline }) : unconfigured;
}

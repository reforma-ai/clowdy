import { FileSystemError } from '@clowdy/file-manager/provider';

import { createFixtureData, withFixtureLastRun, withFixtureWorkspace } from './fixtureData';
import { FIXTURE_BRANCH_SCRIPTS } from './fixtureGitBranches';
import { FIXTURE_REMOTE_SCRIPTS } from './fixtureGitRemote';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { type ProjectFileSystem, type Transport, TransportError } from './transport';

import type { FixturePullRequestScript } from './fixtureData';
import type { FixtureBranchScript } from './fixtureGitBranches';
import type { FixtureRemoteScript } from './fixtureGitRemote';
import type { FixtureCommitScript, FixtureDiscardScript, FixtureMessageScript } from './fixtureGitWrites';

export type DaemonConfig =
    | { kind: 'daemon'; url: string; token: string }
    | {
          kind: 'fixtures';
          timeline: boolean;
          worktree?: true;
          clean?: true;
          base?: true;
          commit?: FixtureCommitScript;
          message?: FixtureMessageScript;
          discard?: Exclude<FixtureDiscardScript, 'ok'>;
          remote?: FixtureRemoteScript;
          pr?: FixturePullRequestScript;
          branches?: FixtureBranchScript[];
      }
    | { kind: 'none' };

/** The words the page's `&pr=` switch knows: what `GET git/pull-request` says of the fixture's worktree. */
const PULL_REQUEST_SCRIPTS = [
    'none',
    'open',
    'draft',
    'merged',
    'closed',
    'no_gh',
    'not_signed_in',
    'no_remote',
    'unavailable',
] as const satisfies readonly FixturePullRequestScript[];

/** The value of a switch of the page's address when it is one of the words the switch knows. */
const oneOf = <T extends string>(value: string | null, words: readonly T[]): T | undefined =>
    words.find(word => word === value);

/**
 * Where the UI gets its data, in order of precedence:
 * 1. `window.desktop.daemon`, which the desktop shell fills in;
 * 2. `?daemon=<url>&token=<token>` in the page URL;
 * 3. `?fixtures`, scripted data in memory (`?fixtures=static` leaves out the timed events, `&worktree` adds the chat that works in a dirty worktree, `?chat=c-9`, whose changes
 *    the side panel's Changes tab shows; `&commit=signing|hook|slow` and `&message=failed|slow` say how a commit and a request for its message end there, which the screenshots of the commit
 *    box use; `&discard=slow|refused|copyfail|hook` says how a discard of a file's changes ends (it takes a while, git refuses the file, the copy cannot be kept, a post-checkout hook fails after the file is back); `&remote=slow|behind|ahead|level|never|diverged|rejected|signing|offline|renamed|no_origin|detached|unborn` says how a fetch, a pull and a push end and where the branch stands against its upstream
 *    and when the repository last fetched (the sync button's states), `&pr=none|open|draft|merged|closed|no_gh|not_signed_in|no_remote|unavailable` what GitHub says of the worktree's branch (`open` by default,
 *    `none` is the one that offers Create PR), `&clean` leaves the worktree with nothing uncommitted (the commit box's `No local changes`), and `&base` puts the worktree on `main`, the branch the work is compared with; `&branches=remote,held,dirty,refused,slow`, any of the
 *    words joined by commas, says what the folder's branches and a switch from the Changes sidebar's branch button are like: branches only origin has, branches that worktrees hold, a checkout with
 *    changes, a switch that is refused for the chats working there, a switch that takes a while);
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
        const discard = oneOf(params.get('discard'), ['slow', 'refused', 'copyfail', 'hook'] as const);
        const remote = oneOf(params.get('remote'), FIXTURE_REMOTE_SCRIPTS);
        const pr = oneOf(params.get('pr'), PULL_REQUEST_SCRIPTS);
        const branches = (params.get('branches') ?? '')
            .split(',')
            .flatMap(word => oneOf(word.trim(), FIXTURE_BRANCH_SCRIPTS) ?? []);

        return {
            kind: 'fixtures',
            timeline: params.get('fixtures') !== 'static',
            ...(params.has('worktree') && { worktree: true as const }),
            ...(params.has('clean') && { clean: true as const }),
            ...(params.has('base') && { base: true as const }),
            ...(commit && { commit }),
            ...(message && { message }),
            ...(discard && { discard }),
            ...(remote && { remote }),
            ...(pr && { pr }),
            ...(branches.length > 0 && { branches }),
        };
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
    getGitViewed: noDaemon,
    setGitViewed: noDaemon,
    clearGitViewed: noDaemon,
    commitGit: noDaemon,
    discardGit: noDaemon,
    generateGitMessage: noDaemon,
    fetchGit: noDaemon,
    pullGit: noDaemon,
    pushGit: noDaemon,
    getGitBranches: noDaemon,
    switchGitBranch: noDaemon,
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
    getHealth: noDaemon,
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

    if (config.kind !== 'fixtures') return unconfigured;

    const { timeline, commit, message, discard, remote, pr, branches, clean, base } = config;
    const data = config.worktree ? withFixtureLastRun(withFixtureWorkspace(createFixtureData())) : createFixtureData();

    // The worktree's branch is the branch the work is compared with, which is where a commit goes straight to the base.
    if (base) for (const chat of data.chats) if (chat.workspace) chat.workspace.branch = 'main';

    // What GitHub says of the worktree's branch, for the states of Create PR to be looked at.
    if (pr) for (const scripts of Object.values(data.pullRequests)) scripts.worktree = pr;

    return new FixtureTransport({
        timeline,
        data,
        gitWrites: { commit, message, discard, remote, ...(clean && { clean }) },
        branches,
    });
}

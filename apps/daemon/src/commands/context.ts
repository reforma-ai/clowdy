import type { Command, CommandType } from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { Config } from '../config';
import type { AgentRegistry } from '../engine/acp/registry';
import type { FilesService } from '../files/service';
import type { FsService } from '../fs/service';
import type { GitBranchMerge } from '../git/branchMerge';
import type { GitClone } from '../git/clone';
import type { GitWrites } from '../git/commit';
import type { GitDiscard } from '../git/discard';
import type { CommitMessages } from '../git/message';
import type { PullRequests } from '../git/pullRequest';
import type { GitRemote } from '../git/remote';
import type { GitSwitch } from '../git/switch';
import type { ModelCatalog } from '../providers/models';
import type { ProvidersService } from '../providers/service';
import type { RunDriver } from '../runs/driver';
import type { ChatQueue } from '../runs/queue';
import type { RunService } from '../runs/service';
import type { ThreadService } from '../runs/threads';
import type { SkillsService } from '../skills/service';
import type { Store } from '../store';
import type { TerminalService } from '../terminals/service';

/** What a command handler may use. */
export interface Services {
    config: Config;
    store: Store;
    runs: RunService;
    driver: RunDriver;
    /** What the person writes while a chat's orchestrator works: the queue, its turns and its steers. */
    queue: ChatQueue;
    /** Threads: chats an agent of another chat starts and drives with its `thread_*` tools. */
    threads: ThreadService;
    files: FilesService;
    /** The files of a project's folders for the file manager. */
    fs: FsService;
    attachments: AttachmentsService;
    skills: SkillsService;
    agents: AgentRegistry;
    providers: ProvidersService;
    models: ModelCatalog;
    /** The shells the app's terminal runs. */
    terminals: TerminalService;
    /** The pull request of a place's branch, read through the person's `gh`. */
    pullRequests: PullRequests;
    /** What the daemon writes to a person's repository: the commit of the files they ticked. */
    gitWrites: GitWrites;
    /** What the daemon does between a person's branch and their `origin`: fetch, pull and push. */
    gitRemote: GitRemote;
    /** Clones a repository into a new folder, and says where a clone would go. */
    gitClone: GitClone;
    /** Previews and starts a merge between two named branches. */
    gitBranchMerge: GitBranchMerge;
    /** What the daemon does to the branch of a folder's own checkout: the switch. */
    gitSwitch: GitSwitch;
    /** The discard of the changes of single files, without recovery copies. */
    gitDiscard: GitDiscard;
    /** The commit message an agent the person chose writes for the files they ticked. */
    commitMessages: CommitMessages;
}

export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/** The commands that wait for an agent or for git before they change anything (a fork, an edit, the removal of a worktree): they have an `AsyncHandlers` entry and no `Handlers` one. */
export type AsyncCommandType = 'chat.fork' | 'chat.edit' | 'workspace.create' | 'workspace.remove';

/**
 * The commands that wait only when they ask for something that needs it (a delete that also removes the chat's worktree waits for git, and so does a chat that is to work in
 * the folder's checkout on another branch): they have a `Handlers` entry for the ordinary case and an `AsyncHandlers` one for the other, which `waitsWhen`
 * (`commands/index.ts`) tells apart.
 */
export type SometimesAsyncCommandType = 'chat.create' | 'chat.delete';

/**
 * One handler per command type, run inside the transaction that also stores the command's result. Handlers are
 * synchronous and publish their events through the domain functions; the returned value is the result's `data`.
 */
export type Handlers = {
    [T in Exclude<CommandType, AsyncCommandType>]: (services: Services, command: CommandOf<T>) => unknown;
};

/**
 * The handlers of the commands that wait (for an agent, or for git). One does its waiting first, outside any transaction, and refuses with a `CommandError` when it must;
 * what it gives back is the part that changes the store, synchronous like any handler and run in the transaction that also stores the result
 * (`executeCommandAsync`), so everything that waited has happened before anything is written.
 */
export type AsyncHandlers = {
    [T in AsyncCommandType | SometimesAsyncCommandType]: (
        services: Services,
        command: CommandOf<T>
    ) => Promise<() => unknown>;
};

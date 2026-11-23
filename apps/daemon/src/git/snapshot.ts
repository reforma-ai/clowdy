import { constants } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { getChat, getChatLastRun, setChatLastRun } from '../db/chats';
import { nextSeq } from '../db/items';
import { getRun, getRunWork } from '../db/runs';
import { gitLine, gitRead } from '../domain/git';
import { workingTreeRoot } from './state';

import type { ChatLastRun } from '@clowdy/protocol';
import type { Store } from '../store';

/** What the two git commands that make a tree may take together; past it the snapshot is given up and nothing is kept. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * How long a turn's start waits for its snapshot before the agent is started anyway: an agent needs a few seconds to start and answer before its first edit, so a snapshot
 * that is done within this is taken before any edit. A slower one (a very large tree) goes on while the agent starts, and an edit made in the agent's first seconds may then be in
 * the start tree and be missed by the scope, which is the price of not holding the turn back.
 */
export const START_WAIT_MS = 1000;

/** How long a turn's end waits for its snapshot before the run settles without it; the snapshot goes on and the plate comes as soon as it is done, since it is pushed with the chat. */
export const END_WAIT_MS = 4000;

/** The settings every git command of a snapshot is run with: the index is written whole, so no `sharedindex.*` file is made in the repository for it. */
const SNAPSHOT_CONFIG = ['-c', 'core.splitIndex=false'];

/**
 * The id of a tree that holds the files of a working directory as `git add -A` would put them in a commit: the tracked files as they are on the disk now, and the new ones that
 * `.gitignore` and the other exclude rules do not hide; a file that was deleted is not there. It is made in an index of its own, a copy of the repository's index in a temporary
 * folder (`GIT_INDEX_FILE`) which is removed again, so the repository's own index, its refs, its config and its working tree are never touched, and the copy's cached file
 * stats make a tree of an unchanged project cost one pass over the files, not one read of each.
 *
 * Objects are written (`add` stores each changed or new file as a blob, and `write-tree` the trees), which is the one trace left in the repository: loose objects that nothing refers
 * to, which git's own `gc` removes after two weeks. The person's clean filters run, as for `git add` (a Git LFS user's clean step stores a file in `.git/lfs`).
 *
 * Nothing when the folder is not the root of a working tree, when git is not there, or when it takes longer than `timeoutMs` (a tree of a huge project, a file too big to hash in time),
 * and for any failure of either command (a file git cannot read): a snapshot is whole or it is none.
 */
export async function snapshotTree(cwd: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    let folder: string | undefined;

    try {
        const [root, index] = await Promise.all([workingTreeRoot(cwd), gitLine(cwd, ['rev-parse', '--git-path', 'index'])]);

        if (!root || !index) return undefined;

        folder = await mkdtemp(join(tmpdir(), 'clowdy-tree-'));

        const own = join(folder, 'index');

        // A repository that has no index yet (no commit, nothing added) starts the copy empty; a clone-on-write copy where the disk has them, a plain one elsewhere.
        await copyFile(resolve(cwd, index), own, constants.COPYFILE_FICLONE).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });

        const env = { GIT_INDEX_FILE: own };
        const added = await gitRead(cwd, [...SNAPSHOT_CONFIG, 'add', '-A'], { env, timeoutMs: Math.max(1, deadline - Date.now()) });

        if (!added.ok) return undefined;

        const written = await gitRead(cwd, [...SNAPSHOT_CONFIG, 'write-tree'], { env, timeoutMs: Math.max(1, deadline - Date.now()) });
        const tree = written.ok ? written.stdout.trim() : '';

        return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) ? tree : undefined;
    }
    catch {
        // A folder that went, a disk that is full, a git that is not there: the turn has no snapshot, and says nothing of it.
        return undefined;
    }
    finally {
        if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Waits for `work` for `ms` at most. What `work` is doing goes on past that by itself, and its failure is not this one's (`work` never rejects). */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([work, new Promise<void>((done) => {
            timer = setTimeout(done, ms);
        })]);
    }
    finally {
        clearTimeout(timer);
    }
}

export interface TurnSnapshotsOptions {
    /** Makes the tree of a folder; `snapshotTree` unless a test says otherwise. */
    snapshot?: (cwd: string) => Promise<string | undefined>;
    startWaitMs?: number;
    endWaitMs?: number;
    now?: () => number;
}

/**
 * The two trees around a turn of a chat's orchestrator, which say what the turn changed (`Chat.lastRun`, `turnScope`). One `TurnTrees` is made when a turn starts (`begin`): it takes the
 * tree of the chat's working directory at once, and when the turn ends (`end`) takes a second and keeps the pair on the chat; they are the same tree for a turn that changed nothing
 * and then nothing is kept, and the chat's earlier record goes, since it is not the latest turn's any more. Only the orchestrator of a chat is measured, and only while it works in the
 * chat's own place: a sub-agent and a run that was given a folder of its own (a thread's `cwd`) have none, and the work of both is in the orchestrator's tree anyway.
 */
export class TurnSnapshots {
    readonly #snapshot: (cwd: string) => Promise<string | undefined>;
    readonly #startWaitMs: number;
    readonly #endWaitMs: number;
    readonly #now: () => number;

    constructor(private readonly store: Store, options: TurnSnapshotsOptions = {}) {
        this.#snapshot = options.snapshot ?? (cwd => snapshotTree(cwd));
        this.#startWaitMs = options.startWaitMs ?? START_WAIT_MS;
        this.#endWaitMs = options.endWaitMs ?? END_WAIT_MS;
        this.#now = options.now ?? Date.now;
    }

    /** The trees of a turn of `runId` that works in `cwd`, started now; nothing for a run that is not a chat's orchestrator in its chat's own place. */
    begin(runId: string, cwd: string): TurnTrees | undefined {
        const run = getRun(this.store.db, runId);

        if (!run || run.role !== 'orchestrator' || run.chatId === undefined || getRunWork(this.store.db, runId).cwd) return undefined;

        return new TurnTrees(this, run.chatId, runId, cwd);
    }

    /** @internal for `TurnTrees` */
    take(cwd: string): Promise<string | undefined> {
        return this.#snapshot(cwd).catch(() => undefined);
    }

    /** @internal for `TurnTrees` */
    get waits(): { start: number; end: number } {
        return { start: this.#startWaitMs, end: this.#endWaitMs };
    }

    /** @internal for `TurnTrees`: where the run's stream is now and what time it is, which is when its turn ended. */
    mark(runId: string): { seq: number; at: number } {
        return { seq: nextSeq(this.store.db, runId) - 1, at: this.#now() };
    }

    /** @internal for `TurnTrees`: keeps what the turn changed on the chat (or forgets the earlier turn's), and publishes the chat when that changed it. */
    keep(chatId: string, trees: Pick<ChatLastRun, 'startTree' | 'endTree' | 'seq' | 'at'> | undefined): void {
        const { store } = this;

        try {
            store.tx(() => {
                const before = getChatLastRun(store.db, chatId);
                const lastRun: ChatLastRun | undefined = trees;

                if (!before && !lastRun) return;

                setChatLastRun(store.db, chatId, lastRun);

                const chat = getChat(store.db, chatId);

                if (chat) store.emit(chat.projectId, { type: 'chat.upserted', chat });
            });
        }
        catch {
            // The chat or the database went while the snapshot was made (the daemon stops, the chat is deleted): there is nothing left to keep it on.
        }
    }
}

/** The trees around one turn: see `TurnSnapshots`. */
export class TurnTrees {
    readonly #start: Promise<string | undefined>;
    #finished?: Promise<void>;

    /** @internal made by `TurnSnapshots.begin` */
    constructor(private readonly owner: TurnSnapshots, private readonly chatId: string, private readonly runId: string, readonly cwd: string) {
        this.#start = owner.take(cwd);
    }

    /** Resolves once the start tree is made, or after `START_WAIT_MS`: the turn's agent is started then, whatever the snapshot has come to. Never rejects. */
    async started(): Promise<void> {
        await within(this.#start, this.owner.waits.start);
    }

    /**
     * Ends the turn: takes the second tree, keeps the pair on the chat when they differ and forgets the chat's earlier record when they do not (or when either could not be made),
     * and resolves when that is done or after `END_WAIT_MS`, whichever comes first; the work goes on by itself past that, and the chat is published when it is done. Asked again,
     * it is the first answer. Never rejects.
     */
    end(): Promise<void> {
        // Where the stream was when the turn ended, not when the second tree is done: a message the person writes meanwhile is newer than the turn.
        this.#finished ??= this.#finish(this.owner.mark(this.runId));

        return within(this.#finished, this.owner.waits.end);
    }

    async #finish(mark: { seq: number; at: number }): Promise<void> {
        const startTree = await this.#start;
        // A turn that could not be measured at its start is not measured at its end either: one failed attempt (not a repository, git gone) is not tried twice.
        const endTree = startTree === undefined ? undefined : await this.owner.take(this.cwd);

        this.owner.keep(this.chatId, startTree !== undefined && endTree !== undefined && startTree !== endTree ? { startTree, endTree, ...mark } : undefined);
    }
}

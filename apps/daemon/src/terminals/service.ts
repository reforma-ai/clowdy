import { isTerminalSize, MAX_TERMINALS } from '@clowdy/protocol';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CommandError, conflict, errorMessage, invalid, notFound, unavailable } from '../errors';
import { isInside, normalizeFsPath, outside } from '../fs/paths';
import { newId } from '../ids';
import { spawnPty } from './pty';
import { TerminalSession } from './session';
import { resolveShell, terminalEnvironment } from './shell';

import type { Project, TerminalCreate, TerminalInfo } from '@clowdy/protocol';
import type { SpawnPty } from './pty';
import type { Shell } from './shell';

/** A shell that ended stays listed this long, so that a window that comes back still reads what it printed last. */
const EXITED_TTL_MS = 30 * 60_000;
const SWEEP_MS = 60_000;

export interface TerminalServiceOptions {
    /** The program a terminal runs; the person's own shell. */
    shell?: () => Shell;
    /** What a shell inherits; the daemon's own environment. */
    env?: () => Record<string, string | undefined>;
    /** Starts the program on a PTY; Bun's. */
    spawn?: SpawnPty;
    maxTerminals?: number;
    exitedTtlMs?: number;
}

/**
 * The shells the daemon runs for its clients. They belong to the daemon, not to a connection: they live until they are closed, they exit, or the daemon
 * stops, and a client can come and go.
 */
export class TerminalService {
    readonly #sessions = new Map<string, TerminalSession>();
    readonly #options: TerminalServiceOptions;
    readonly #sweeper: ReturnType<typeof setInterval>;

    constructor(options: TerminalServiceOptions = {}) {
        this.#options = options;
        this.#sweeper = setInterval(() => this.#sweep(), SWEEP_MS);
        this.#sweeper.unref?.();
    }

    create(project: Project, request: TerminalCreate): TerminalInfo {
        if (!isTerminalSize(request.cols, request.rows)) {
            throw invalid('The size of the terminal is not one a terminal can have');
        }

        const limit = this.#options.maxTerminals ?? MAX_TERMINALS;

        if ([...this.#sessions.values()].filter(session => session.isRunning).length >= limit) {
            throw conflict(`This machine already runs ${ limit } terminals`, { reason: 'limit' });
        }

        const folder = project.folders.find(candidate => candidate.id === request.folderId);

        if (!folder) {
            throw notFound('Folder', request.folderId);
        }

        const session = new TerminalSession(newId('trm'), {
            projectId: project.id,
            folderId: folder.id,
            cwd: directoryIn(folder.path, request.path),
            shell: (this.#options.shell ?? resolveShell)(),
            env: terminalEnvironment(this.#options.env?.() ?? process.env),
            cols: request.cols,
            rows: request.rows,
        });

        try {
            session.start(this.#options.spawn ?? spawnPty);
        }
        catch (error) {
            session.dispose();

            throw unavailable(`The shell could not be started: ${ errorMessage(error) }`);
        }

        this.#sessions.set(session.id, session);

        return session.info();
    }

    /** Running terminals and recently exited ones, oldest first; those of one project when it is named. */
    list(projectId?: string): TerminalInfo[] {
        return [...this.#sessions.values()]
            .filter(session => projectId === undefined || session.spec.projectId === projectId)
            .map(session => session.info());
    }

    find(id: string): TerminalSession | undefined {
        return this.#sessions.get(id);
    }

    require(id: string): TerminalSession {
        const session = this.find(id);

        if (!session) {
            throw notFound('Terminal', id);
        }

        return session;
    }

    /** Ends the shell and forgets the terminal. */
    remove(id: string): void {
        this.require(id).dispose();
        this.#sessions.delete(id);
    }

    /** Ends every shell: the daemon is stopping. */
    stop(): void {
        clearInterval(this.#sweeper);

        for (const session of this.#sessions.values()) {
            session.dispose();
        }

        this.#sessions.clear();
    }

    #sweep(): void {
        const ttl = this.#options.exitedTtlMs ?? EXITED_TTL_MS;

        for (const [id, session] of this.#sessions) {
            if (session.endedAt !== undefined && Date.now() - session.endedAt > ttl) {
                session.dispose();
                this.#sessions.delete(id);
            }
        }
    }
}

/** The real path of the project folder, or of a folder below it, which must be a folder that is there and that no link leads out of. */
function directoryIn(root: string, path = ''): string {
    let base: string;

    try {
        base = realpathSync(root);
    }
    catch {
        throw unavailable(`The folder ${ root } is missing`);
    }

    const wanted = join(base, normalizeFsPath(path));
    let real: string;

    try {
        real = realpathSync(wanted);
    }
    catch {
        throw new CommandError('not_found', `${ path } does not exist`, { path });
    }

    if (!isInside(base, real)) {
        throw outside('The path leads out of the folder');
    }

    if (!statSync(real).isDirectory()) {
        throw invalid(`${ path } is not a folder`, { path });
    }

    return real;
}

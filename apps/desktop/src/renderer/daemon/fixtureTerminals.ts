import type { Project, ProjectId, TerminalCreate, TerminalId, TerminalInfo } from '@clowdy/protocol';
import type { TerminalStream, TerminalStreamHandlers } from './terminalStream';

const PROMPT = '\x1b[32mdev@clowdy\x1b[0m \x1b[34m~\x1b[0m $ ';

const encoder = new TextEncoder();

/**
 * A shell in memory: it prints a prompt, echoes what is typed, and answers a line with the line itself. A stand-in for the daemon's PTY so the terminal
 * can be drawn, typed into and screenshotted without one; it knows no real command except `exit`.
 */
class FixtureShell {
    readonly info: TerminalInfo;
    #screen = `Fixture shell: nothing here is run\r\n${ PROMPT }`;
    #line = '';
    readonly #streams = new Set<TerminalStreamHandlers>();

    constructor(id: TerminalId, request: TerminalCreate, cwd: string, createdAt: number) {
        this.info = { id, projectId: request.projectId, folderId: request.folderId, cwd, shell: 'zsh', cols: request.cols, rows: request.rows, state: 'running', createdAt };
    }

    open(handlers: TerminalStreamHandlers): TerminalStream {
        this.#streams.add(handlers);
        handlers.onStatus('open');
        handlers.onScreen({ screen: this.#screen, cols: this.info.cols, rows: this.info.rows, state: this.info.state, exitCode: this.info.exitCode });

        if (this.info.state === 'exited') handlers.onExit(this.info.exitCode ?? 0);

        return {
            write: (data) => {
                if (this.info.state !== 'running') return false;

                for (const character of data) this.#type(character);

                return true;
            },
            resize: (cols, rows) => {
                this.info.cols = cols;
                this.info.rows = rows;
            },
            close: () => void this.#streams.delete(handlers),
        };
    }

    close(): void {
        this.#streams.clear();
    }

    #print(text: string): void {
        this.#screen += text;

        for (const handlers of this.#streams) handlers.onOutput(encoder.encode(text));
    }

    #type(character: string): void {
        if (character === '\r') {
            const line = this.#line.trim();

            this.#line = '';
            this.#print('\r\n');

            if (line === 'exit') {
                this.info.state = 'exited';
                this.info.exitCode = 0;

                for (const handlers of this.#streams) handlers.onExit(0);

                return;
            }

            this.#print(line === '' ? PROMPT : `fixture: ${ line }: command not found\r\n${ PROMPT }`);
        }
        else if (character === '\x7f') {
            if (this.#line.length > 0) {
                this.#line = this.#line.slice(0, -1);
                this.#print('\b \b');
            }
        }
        else if (character >= ' ') {
            this.#line += character;
            this.#print(character);
        }
    }
}

/** The terminals of a fixture daemon. */
export class FixtureTerminals {
    readonly #shells = new Map<TerminalId, FixtureShell>();
    #counter = 0;

    list(projectId?: ProjectId): TerminalInfo[] {
        return [...this.#shells.values()].filter(shell => projectId === undefined || shell.info.projectId === projectId).map(shell => structuredClone(shell.info));
    }

    create(project: Project, request: TerminalCreate): TerminalInfo {
        const folder = project.folders.find(candidate => candidate.id === request.folderId);

        if (!folder) throw new Error(`Folder ${ request.folderId } does not exist`);

        const shell = new FixtureShell(`trm_fixture${ ++this.#counter }`, request, request.path ? `${ folder.path }/${ request.path }` : folder.path, Date.now());

        this.#shells.set(shell.info.id, shell);

        return structuredClone(shell.info);
    }

    close(id: TerminalId): void {
        this.#shells.get(id)?.close();
        this.#shells.delete(id);
    }

    open(id: TerminalId, handlers: TerminalStreamHandlers): TerminalStream {
        const shell = this.#shells.get(id);

        if (!shell) {
            handlers.onGone();

            return { write: () => false, resize: () => undefined, close: () => undefined };
        }

        return shell.open(handlers);
    }
}

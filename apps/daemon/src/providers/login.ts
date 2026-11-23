import { spawnInOwnGroup } from '../engine/process';

import type { AgentSignInSession } from '@clowdy/protocol';
import type { AgentRegistry } from '../engine/acp/registry';
import type { AgentProcess } from '../engine/process';
import type { Provider } from './types';

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** A finished session stays visible this long, so the page can say how it ended. */
const KEEP_FINISHED_MS = 2 * 60_000;
const OUTPUT_TAIL_CHARS = 8000;
/** After the program ended, output it wrote last may still be on its way: wait this long for the pipes to close. */
const OUTPUT_GRACE_MS = 200;

export class SignInError extends Error {
    constructor(
        readonly kind: 'invalid' | 'conflict',
        message: string
    ) {
        super(message);
    }
}

/* eslint-disable no-control-regex -- terminal escape sequences are the point */
const OSC_LINK = /\u001B\]8;[^;\u0007\u001B]*;([^\u0007\u001B]+)(?:\u0007|\u001B\\)/g;
const ESCAPES = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
/** The address of the login program's own listener (`Starting local login server on http://localhost:1455`): the page is somewhere else. */
const LOOPBACK = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/** What a login program printed that a person needs: the link to open, and a one-time code to enter there. */
export function parseSignInOutput(output: string): { url?: string; code?: string; denied?: boolean } {
    // A terminal hyperlink names its target apart from its text: the last one is the one on screen.
    const hyperlinks = [...output.matchAll(OSC_LINK)].map(match => match[1]!);
    const plain = output.replace(ESCAPES, '');
    const printed = [...plain.matchAll(URL_IN_TEXT)]
        .map(match => match[0].replace(/[.,;:)\]]+$/, ''))
        .find(link => !LOOPBACK.test(link));
    const url = hyperlinks.at(-1) ?? printed;
    // Not inside a link: its ids and states have the shape of a code too.
    const code = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/.exec(plain.replace(URL_IN_TEXT, ' '))?.[0];

    return {
        ...(url && { url }),
        ...(code && { code }),
        ...(/access_denied|authorization denied|login (was )?cancel+ed/i.test(plain) && { denied: true }),
    };
}

/** The last line of output that says something, for the message of a failed sign-in. */
function lastLine(output: string): string | undefined {
    return output
        .replace(ESCAPES, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .at(-1)
        ?.slice(0, 200);
}

interface Session extends AgentSignInSession {
    endedAt?: number;
}

export interface LoginOptions {
    registry: AgentRegistry;
    providers: ReadonlyMap<string, Provider>;
    /** Tells the clients the session changed. */
    announce: () => void;
    /** Called once a login program ended well: the account is read again. */
    onSignedIn: (id: string) => void;
    now?: () => number;
    cwd: string;
    timeoutMs?: number;
}

/**
 * Runs the vendor's own login program (`claude auth login`, `codex login`, `cursor-agent login`) for the person. The
 * program opens the browser and keeps the tokens in its own store; this only starts it, passes on the link and code it
 * prints, and notices how it ended. One sign-in per agent at a time. Nothing here sees a token.
 */
export class LoginSessions {
    private sessions = new Map<string, { session: Session; proc?: AgentProcess; cancelled: boolean }>();
    private now: () => number;
    private timeoutMs: number;

    constructor(private options: LoginOptions) {
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    }

    /** The session to show for `id`: one in progress, or one that ended recently. */
    get(id: string): AgentSignInSession | undefined {
        const entry = this.sessions.get(id);

        if (!entry) {
            return undefined;
        }

        if (entry.session.endedAt !== undefined && this.now() - entry.session.endedAt > KEEP_FINISHED_MS) {
            this.sessions.delete(id);

            return undefined;
        }

        const { endedAt: _endedAt, ...session } = entry.session;

        return session;
    }

    /** Starts the login at once and answers; progress is read with `get`. Refused when the agent has no login to run or one is running. */
    start(id: string): void {
        if (!this.options.providers.get(id)?.login) {
            throw new SignInError('invalid', `Clowdy cannot sign in to ${this.options.registry.nameOf(id)} for you`);
        }

        const running = this.sessions.get(id);

        if (running && running.session.endedAt === undefined) {
            throw new SignInError('conflict', `A sign-in to ${this.options.registry.nameOf(id)} is already running`);
        }

        const entry = { session: { step: 'starting', startedAt: this.now() } as Session, cancelled: false };

        this.sessions.set(id, entry);
        void this.run(id, entry).catch(error =>
            this.finish(
                entry,
                'failed',
                `The sign-in to ${this.options.registry.nameOf(id)} broke: ${error instanceof Error ? error.message : String(error)}`
            )
        );
    }

    /** Stops the sign-in in progress. */
    cancel(id: string): void {
        const entry = this.sessions.get(id);

        if (!entry || entry.session.endedAt !== undefined) {
            return;
        }

        entry.cancelled = true;
        entry.proc?.stop();

        // The program may be gone before it was ever started.
        if (!entry.proc) {
            this.finish(entry, 'cancelled', 'Sign-in cancelled');
        }
    }

    /** Stops every sign-in, for when the daemon stops. */
    stop(): void {
        for (const entry of this.sessions.values()) {
            entry.cancelled = true;
            entry.proc?.stop();
        }
    }

    private finish(entry: { session: Session }, step: Session['step'], message?: string): void {
        if (entry.session.endedAt !== undefined) {
            return;
        }

        entry.session.step = step;
        entry.session.endedAt = this.now();

        if (message) {
            entry.session.message = message;
        }

        this.options.announce();
    }

    private async run(id: string, entry: { session: Session; proc?: AgentProcess; cancelled: boolean }): Promise<void> {
        const provider = this.options.providers.get(id)!;
        const name = this.options.registry.nameOf(id);
        let target: Awaited<ReturnType<AgentRegistry['probeTarget']>>;

        this.options.announce();

        try {
            target = await this.options.registry.probeTarget(id);

            if (!target) {
                this.finish(entry, 'failed', `${name} is not installed or is switched off in Clowdy`);

                return;
            }

            if (entry.cancelled) {
                this.finish(entry, 'cancelled', 'Sign-in cancelled');

                return;
            }

            entry.proc = await spawnInOwnGroup({
                command: target.program,
                args: provider.login!.args,
                cwd: this.options.cwd,
                env: { ...target.env, NO_COLOR: '1', TERM: 'dumb' },
            });
        } catch (error) {
            this.finish(
                entry,
                'failed',
                `Could not start ${name}: ${error instanceof Error ? error.message : String(error)}`
            );

            return;
        }

        const { proc } = entry;
        let output = '';
        // Ended by us (the deadline, a refusal): whatever the program then exits with, the person did not sign in.
        let stopped = false;
        const timer = setTimeout(() => {
            entry.session.message = 'The sign-in took too long';
            stopped = true;
            proc.stop();
        }, this.timeoutMs);
        const onData = (text: string) => {
            output = (output + text).slice(-OUTPUT_TAIL_CHARS);

            const found = parseSignInOutput(output);
            const before = `${entry.session.url}|${entry.session.code}`;

            if (found.url) {
                entry.session.url = found.url;
            }

            if (found.code) {
                entry.session.code = found.code;
            }

            if (found.denied) {
                entry.session.message = 'The sign-in was refused';
                stopped = true;
                proc.stop();
            }

            if (before !== `${entry.session.url}|${entry.session.code}`) {
                this.options.announce();
            }
        };

        proc.child.stdout?.setEncoding('utf8').on('data', onData);
        proc.child.stderr?.setEncoding('utf8').on('data', onData);
        proc.child.stdin?.on('error', () => undefined);
        entry.session.step = 'waiting';
        this.options.announce();

        const code = await new Promise<number | null>(resolve => {
            proc.child.once('exit', exitCode => {
                // Its last words may still be in the pipes (`close` says they are not), and a leftover that holds them open must not hold us.
                const grace = setTimeout(() => resolve(exitCode), OUTPUT_GRACE_MS);

                proc.child.once('close', () => {
                    clearTimeout(grace);
                    resolve(exitCode);
                });
            });
            proc.child.once('error', () => resolve(null));
        });

        clearTimeout(timer);

        if (entry.cancelled) {
            this.finish(entry, 'cancelled', 'Sign-in cancelled');
        } else if (code === 0 && !stopped) {
            this.finish(entry, 'done');
            this.options.onSignedIn(id);
        } else {
            this.finish(
                entry,
                'failed',
                entry.session.message ?? lastLine(output) ?? `${name} ended the sign-in (exit code ${code ?? 'none'})`
            );
        }
    }
}

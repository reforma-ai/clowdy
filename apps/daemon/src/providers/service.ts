import { homedir, tmpdir } from 'node:os';

import { PROVIDERS } from './builtin';
import { LoginSessions } from './login';

import type { AgentInfo, AgentSignIn, AgentUsage } from '@clowdy/protocol';
import type { AgentRegistry } from '../engine/acp/registry';
import type { ProbeContext, Provider } from './types';

/** A read is reused this long; usage moves slowly and each read starts the vendor's program. */
const FRESH_MS = 90_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

/** How long a read that failed `failures` times in a row waits before the next one: 30 s, 60 s, up to 5 min. */
const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));

export interface ProvidersOptions {
    registry: AgentRegistry;
    /** Tells every client that agents changed, so it refetches `GET /v1/agents`. */
    announce: () => void;
    providers?: readonly Provider[];
    fetch?: typeof fetch;
    now?: () => number;
    freshMs?: number;
    platform?: NodeJS.Platform;
    home?: string;
    cwd?: string;
    loginTimeoutMs?: number;
}

interface Entry {
    signIn?: AgentSignIn;
    usage?: AgentUsage;
    /** Reads are not started again before this time. */
    nextAt: number;
    failures: number;
    inflight?: Promise<void>;
    /** Bumped by `forget`, so a read that started before it does not store what it found. */
    generation: number;
}

/**
 * Who is signed in to each agent and how much of its plan is used, read from the agent's own program (and, for Cursor, its
 * dashboard) and kept in memory. Nothing here starts a run. Reads happen when somebody asks for the agents and the last
 * read is old, one at a time per agent; a failed read is tried again after a growing pause and the last good usage stays.
 */
export class ProvidersService {
    private entries = new Map<string, Entry>();
    private providers: Map<string, Provider>;
    private now: () => number;
    private freshMs: number;
    private logins: LoginSessions;
    /** Fires in `stop`: programs a read started end, and nothing starts or announces after it. */
    private stopper = new AbortController();

    constructor(private options: ProvidersOptions) {
        this.providers = new Map((options.providers ?? PROVIDERS).map(provider => [provider.spec.id, provider]));
        this.now = options.now ?? Date.now;
        this.freshMs = options.freshMs ?? FRESH_MS;
        this.logins = new LoginSessions({
            registry: options.registry,
            providers: this.providers,
            announce: () => this.announce(),
            // The account is read again as soon as the vendor's program says it is done.
            onSignedIn: id => void this.readNow(id).then(() => this.announce()),
            now: this.now,
            cwd: options.cwd ?? tmpdir(),
            timeoutMs: options.loginTimeoutMs,
        });
    }

    /** Starts the agent's own login for the person; progress shows in `signInSession`. */
    signIn(id: string): void {
        this.logins.start(id);
    }

    cancelSignIn(id: string): void {
        this.logins.cancel(id);
    }

    /** Ends what runs for the agents (logins and reads), for when the daemon stops. */
    stop(): void {
        this.stopper.abort();
        this.logins.stop();
    }

    /** The agents as `GET /v1/agents` answers: what the registry found, plus what is known of each account and its usage; stale reads start in the background. */
    decorate(infos: AgentInfo[]): AgentInfo[] {
        return infos.map(info => {
            const provider = this.providers.get(info.id);

            // A provider with no reader and no login has nothing to add to what the registry found.
            if (!provider || (!provider.read && !provider.login) || info.status !== 'ready') {
                return info;
            }

            this.ensure(info.id);

            const entry = this.entries.get(info.id);
            const signInSession = this.logins.get(info.id);

            return {
                ...info,
                canSignIn: provider.login !== undefined,
                ...(signInSession && { signInSession }),
                ...(entry?.signIn && { signIn: entry.signIn }),
                ...(entry?.usage && { usage: entry.usage }),
            };
        });
    }

    /** Reads every agent again now, for the Refresh button and for after a sign-in. */
    refresh(): void {
        for (const [id, entry] of this.entries) {
            entry.nextAt = 0;
            entry.failures = 0;
            this.ensure(id);
        }

        void this.options.registry.list().then(infos => {
            for (const info of infos) {
                if (info.status === 'ready' && this.providers.get(info.id)?.read) {
                    this.ensure(info.id);
                }
            }
        });
    }

    /** Drops what is known of one agent (it was switched off, or its program or environment changed). */
    forget(id: string): void {
        const entry = this.entries.get(id);

        if (entry) {
            entry.generation++;
            this.entries.delete(id);
        }
    }

    /**
     * Reads one agent now and waits for it; a sign-in that just ended uses it. A read already under way began before the
     * caller's news and may have seen the old account, so it is waited out and another one follows.
     */
    async readNow(id: string): Promise<void> {
        await this.entries.get(id)?.inflight;

        this.entry(id).nextAt = 0;
        await this.ensure(id);
    }

    /**
     * Whether somebody is signed in to the agent, as the last read says (`signIn.status` `signed-in`: `unknown` is not a yes). An agent that has not been read yet is read now and waited
     * for, so a caller that arrives before anybody listed the agents is not told no. For what has to know before it spends the person's plan (a commit message the daemon asks an agent to
     * write); a screen reads `GET /v1/agents`.
     */
    async signedIn(id: string): Promise<boolean> {
        if (!this.entries.get(id)?.signIn) {
            await this.readNow(id);
        }

        return this.entries.get(id)?.signIn?.status === 'signed-in';
    }

    /** Tells the clients. A failure to tell must not reach the read or the login program that asked, and nobody is told once the daemon has stopped (its database is closed). */
    private announce(): void {
        if (this.stopper.signal.aborted) {
            return;
        }

        try {
            this.options.announce();
        } catch (error) {
            console.error('[clowdy] announcing a change of agents failed:', error);
        }
    }

    private entry(id: string): Entry {
        let entry = this.entries.get(id);

        if (!entry) {
            entry = { nextAt: 0, failures: 0, generation: 0 };
            this.entries.set(id, entry);
        }

        return entry;
    }

    private ensure(id: string): Promise<void> | undefined {
        // A provider with no reader has no account to read: nothing to keep.
        if (!this.providers.get(id)?.read) {
            return undefined;
        }

        const entry = this.entry(id);

        if (entry.inflight || this.now() < entry.nextAt || this.stopper.signal.aborted) {
            return entry.inflight;
        }

        const generation = entry.generation;

        entry.inflight = this.read(id, entry, generation)
            .catch(error => {
                // A reader never throws, so this is a fault in the registry or here. Say so once per try, and wait as after any failed read.
                console.error(`[clowdy] reading the account of ${id} failed:`, error);
                entry.failures++;
                entry.nextAt = this.now() + retryDelay(entry.failures);
            })
            .finally(() => {
                entry.inflight = undefined;
            });

        return entry.inflight;
    }

    private async context(id: string): Promise<ProbeContext | undefined> {
        const target = await this.options.registry.probeTarget(id);

        return (
            target && {
                ...target,
                cwd: this.options.cwd ?? tmpdir(),
                fetch: this.options.fetch ?? fetch,
                now: this.now,
                platform: this.options.platform ?? process.platform,
                home: this.options.home ?? homedir(),
                signal: this.stopper.signal,
            }
        );
    }

    private async read(id: string, entry: Entry, generation: number): Promise<void> {
        const context = await this.context(id);

        if (!context) {
            return;
        }

        const provider = this.providers.get(id)!;
        const read = await provider.read!(context);

        if (generation !== entry.generation || this.stopper.signal.aborted) {
            return;
        }

        const previous = { signIn: entry.signIn, usage: entry.usage };
        const signIn: AgentSignIn = { ...read.signIn, checkedAt: this.now() };
        let { usage } = read;

        // A failed read keeps the last good numbers, marked as an error, instead of an empty card.
        if (usage.state === 'error' && previous.usage && previous.usage.windows.length > 0) {
            usage = {
                ...usage,
                windows: previous.usage.windows,
                ...(previous.usage.fetchedAt !== undefined && { fetchedAt: previous.usage.fetchedAt }),
            };
        }

        const failed = signIn.status === 'unknown' || usage.state === 'error';

        entry.failures = failed ? entry.failures + 1 : 0;
        entry.nextAt =
            this.now() + (failed ? retryDelay(entry.failures) : (this.providers.get(id)?.freshMs ?? this.freshMs));
        entry.signIn = signIn;
        entry.usage = usage;

        const changed =
            JSON.stringify([
                previous.signIn && { ...previous.signIn, checkedAt: 0 },
                previous.usage && { ...previous.usage, fetchedAt: 0 },
            ]) !==
            JSON.stringify([
                { ...signIn, checkedAt: 0 },
                { ...usage, fetchedAt: 0 },
            ]);

        if (changed) {
            this.announce();
        }
    }
}

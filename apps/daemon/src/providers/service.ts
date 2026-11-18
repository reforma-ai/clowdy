import { homedir, tmpdir } from 'node:os';

import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';

import type { AgentInfo, AgentSignIn, AgentUsage } from '@clowdy/protocol';
import type { AgentRegistry } from '../engine/acp/registry';
import type { ProbeContext, Provider } from './types';

/** A read is reused this long; usage moves slowly and each read starts the vendor's program. */
const FRESH_MS = 90_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

export const PROVIDERS: readonly Provider[] = [claude, codex, cursor];

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

    constructor(private options: ProvidersOptions) {
        this.providers = new Map((options.providers ?? PROVIDERS).map(provider => [provider.id, provider]));
        this.now = options.now ?? Date.now;
        this.freshMs = options.freshMs ?? FRESH_MS;
    }

    /** Whether the daemon knows how to read this agent. */
    has(id: string): boolean {
        return this.providers.has(id);
    }

    /** The agents as `GET /v1/agents` answers: what the registry found, plus what is known of each account and its usage; stale reads start in the background. */
    decorate(infos: AgentInfo[]): AgentInfo[] {
        return infos.map((info) => {
            const provider = this.providers.get(info.id);

            if (!provider || info.status !== 'ready') {
                return info;
            }

            this.ensure(info.id);

            const entry = this.entries.get(info.id);

            return {
                ...info,
                canSignIn: provider.login !== undefined,
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

        void this.options.registry.list().then((infos) => {
            for (const info of infos) {
                if (info.status === 'ready' && this.providers.has(info.id)) {
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

    /** Reads one agent now and waits for it; a sign-in that just ended uses it. */
    async readNow(id: string): Promise<void> {
        const entry = this.entry(id);

        entry.nextAt = 0;
        await (entry.inflight ?? this.ensure(id));
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
        const entry = this.entry(id);

        if (entry.inflight || this.now() < entry.nextAt) {
            return entry.inflight;
        }

        const generation = entry.generation;

        entry.inflight = this.read(id, entry, generation)
            .catch(() => undefined)
            .finally(() => {
                entry.inflight = undefined;
            });

        return entry.inflight;
    }

    private async context(id: string): Promise<ProbeContext | undefined> {
        const target = await this.options.registry.probeTarget(id);

        return target && {
            ...target,
            cwd: this.options.cwd ?? tmpdir(),
            fetch: this.options.fetch ?? fetch,
            now: this.now,
            platform: this.options.platform ?? process.platform,
            home: this.options.home ?? homedir(),
        };
    }

    private async read(id: string, entry: Entry, generation: number): Promise<void> {
        const context = await this.context(id);

        if (!context) {
            return;
        }

        const read = await this.providers.get(id)!.read(context);

        if (generation !== entry.generation) {
            return;
        }

        const previous = { signIn: entry.signIn, usage: entry.usage };
        const signIn: AgentSignIn = { ...read.signIn, checkedAt: this.now() };
        let { usage } = read;

        // A failed read keeps the last good numbers, marked as an error, instead of an empty card.
        if (usage.state === 'error' && previous.usage && previous.usage.windows.length > 0) {
            usage = { ...usage, windows: previous.usage.windows, ...(previous.usage.fetchedAt !== undefined && { fetchedAt: previous.usage.fetchedAt }) };
        }

        const failed = signIn.status === 'unknown' || usage.state === 'error';

        entry.failures = failed ? entry.failures + 1 : 0;
        entry.nextAt = this.now() + (failed ? Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (entry.failures - 1)) : this.freshMs);
        entry.signIn = signIn;
        entry.usage = usage;

        const changed = JSON.stringify([previous.signIn && { ...previous.signIn, checkedAt: 0 }, previous.usage && { ...previous.usage, fetchedAt: 0 }])
            !== JSON.stringify([{ ...signIn, checkedAt: 0 }, { ...usage, fetchedAt: 0 }]);

        if (changed) {
            this.options.announce();
        }
    }
}

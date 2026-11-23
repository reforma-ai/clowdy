import { homedir, tmpdir } from 'node:os';

import { PROVIDERS } from './builtin';

import type { AgentModels } from '@clowdy/protocol';
import type { AgentRegistry } from '../engine/acp/registry';
import type { ProbeContext, Provider } from './types';

/** The list moves with the account and the program's version, not by the minute. */
const FRESH_MS = 10 * 60_000;

/* ------------------------------------ the catalog ------------------------------- */

export interface ModelCatalogOptions {
    registry: AgentRegistry;
    /** The providers whose `models` method lists an agent's models: the built-in ones when absent. An agent whose provider has none has no list Clowdy can read. */
    providers?: readonly Provider[];
    now?: () => number;
    freshMs?: number;
    cwd?: string;
    fetch?: typeof fetch;
    platform?: NodeJS.Platform;
    home?: string;
}

interface Cached {
    at: number;
    models: Promise<AgentModels>;
}

/**
 * The models of each agent, read from the agent's own program the first time somebody asks and kept for ten minutes
 * (a failed read is not kept). Nothing is read in the background and no chat is started, so asking is the only cost.
 */
export class ModelCatalog {
    private cache = new Map<string, Cached>();
    private now: () => number;
    private providers: ReadonlyMap<string, Provider>;
    /** Fires in `stop`, so the programs of a read under way end with the daemon. */
    private stopper = new AbortController();

    constructor(private options: ModelCatalogOptions) {
        this.now = options.now ?? Date.now;
        this.providers = new Map((options.providers ?? PROVIDERS).map(provider => [provider.spec.id, provider]));
    }

    async get(id: string): Promise<AgentModels> {
        const provider = this.providers.get(id);

        if (!provider?.models) {
            return {
                state: 'unavailable',
                models: [],
                detail: `Clowdy cannot list the models of ${this.options.registry.nameOf(id)} yet`,
            };
        }

        const cached = this.cache.get(id);

        if (cached && this.now() - cached.at < (this.options.freshMs ?? FRESH_MS)) {
            return await cached.models;
        }

        // Kept before the first wait, so callers that ask together share one read.
        const entry = { at: this.now(), models: this.read(id, provider.models.bind(provider)) };

        this.cache.set(id, entry);

        const result = await entry.models;

        // A failure is asked again next time.
        if (result.state !== 'ok' && this.cache.get(id) === entry) {
            this.cache.delete(id);
        }

        return result;
    }

    private async read(id: string, route: (context: ProbeContext) => Promise<AgentModels>): Promise<AgentModels> {
        try {
            const target = await this.options.registry.probeTarget(id);

            if (!target) {
                return {
                    state: 'unavailable',
                    models: [],
                    detail: `${this.options.registry.nameOf(id)} is not installed or is switched off in Clowdy`,
                };
            }

            return await route({
                ...target,
                cwd: this.options.cwd ?? tmpdir(),
                fetch: this.options.fetch ?? fetch,
                now: this.now,
                platform: this.options.platform ?? process.platform,
                home: this.options.home ?? homedir(),
                signal: this.stopper.signal,
            });
        } catch (error) {
            return { state: 'error', models: [], detail: error instanceof Error ? error.message : String(error) };
        }
    }

    /** Ends the reads under way, for when the daemon stops. */
    stop(): void {
        this.stopper.abort();
    }

    /** Forgets what was read, for when the program, the account or the environment changed. */
    forget(id?: string): void {
        if (id === undefined) {
            this.cache.clear();
        } else {
            this.cache.delete(id);
        }
    }
}

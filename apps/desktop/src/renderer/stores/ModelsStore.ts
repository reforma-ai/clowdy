import { makeAutoObservable, observableRef, runInAction } from 'mobx';

import type { AgentModels } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

export type ModelsStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * The models one agent offers. `status` is about the request: `ready` also covers an answer that says the agent cannot list its
 * models (`models.state`), `failed` is a request that did not get an answer. A list that was read stays in `models` while a newer one is on its way.
 */
export class AgentModelList {
    status: ModelsStatus = 'idle';
    models: AgentModels | undefined;
    error = '';
    #request = 0;
    /** The read of the newest request: what `load()` and a replaced `reload()` wait for. */
    #newest: Promise<void> = Promise.resolve();

    constructor(readonly agentId: string, private readonly transport: Transport) {
        makeAutoObservable<AgentModelList, 'transport'>(this, { agentId: false, transport: false, models: observableRef });
    }

    /**
     * Reads the list when there is none to show: the first time, and again for each call after a read that gave no models (the request
     * failed, or the agent said `unavailable` or `error`: it was not installed or not signed in then, and may be now; the daemon does not
     * keep such an answer). A list that has models is not read again by this. A call made while a read is under way ends with it, so
     * a caller asking again (the picker each time it opens) never starts a second read beside one that is running, and nothing here
     * repeats on its own.
     */
    async load(): Promise<void> {
        if (this.status === 'loading') return await this.#settled();

        if (this.status === 'ready' && this.models?.state === 'ok') return;

        await this.reload();
    }

    /**
     * Reads the list again. The newest request wins, so a slow answer never replaces a newer one, and the promise ends only when the
     * newest request has (as `RootStore.refreshAgents` does): a caller that waits for the list must not be released by an answer that was already replaced.
     */
    async reload(): Promise<void> {
        this.status = 'loading';
        this.#newest = this.#read(++this.#request);

        await this.#settled();
    }

    async #read(request: number): Promise<void> {
        try {
            const models = await this.transport.getAgentModels(this.agentId);

            if (request !== this.#request) return;

            runInAction(() => {
                this.models = models;
                this.status = 'ready';
                this.error = '';
            });
        }
        catch (error) {
            if (request !== this.#request) return;

            runInAction(() => {
                this.status = 'failed';
                this.error = error instanceof Error ? error.message : String(error);
            });
        }
    }

    /** Ends when the newest read has, however many started while this waited. */
    async #settled(): Promise<void> {
        let waited: Promise<void>;

        do {
            waited = this.#newest;
            await waited;
        } while (waited !== this.#newest);
    }
}

/** The model lists the UI has asked for, by agent id. The daemon keeps each for ten minutes, so asking again is cheap. */
export class ModelsStore {
    readonly #lists = new Map<string, AgentModelList>();

    constructor(private readonly transport: Transport) {}

    /** The list of an agent. Creating it does not read: call `load()` (the `useAgentModels` hook does). */
    of(agentId: string): AgentModelList {
        let list = this.#lists.get(agentId);

        if (!list) {
            list = new AgentModelList(agentId, this.transport);
            this.#lists.set(agentId, list);
        }

        return list;
    }

    /** After the agents changed (a sign-in, an install): the lists that were opened may have changed too. */
    async reloadOpened(): Promise<void> {
        await Promise.all([...this.#lists.values()].filter(list => list.status !== 'idle').map(list => list.reload()));
    }
}

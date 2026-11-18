// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { RootStoreProvider, useAgentModels } from './hooks';
import { ModelsStore, type AgentModelList } from './ModelsStore';
import { RootStore } from './RootStore';

import type { AgentModels } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (...ids: string[]): AgentModels => ({ state: 'ok', models: ids.map(id => ({ id, name: id })) });

/** A transport whose model reads the test releases by hand, in the order they were asked. */
function slowTransport() {
    const asked: { agentId: string; release: (answer: AgentModels) => void; fail: (error: Error) => void }[] = [];
    const transport = {
        getAgentModels: (agentId: string) => new Promise<AgentModels>((resolve, reject) => {
            asked.push({ agentId, release: resolve, fail: reject });
        }),
    } as unknown as Transport;

    return { transport, asked };
}

/** Tells whether a promise has ended, without waiting for it. */
async function ended(promise: Promise<unknown>): Promise<boolean> {
    let done = false;

    void promise.then(() => {
        done = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    return done;
}

describe('ModelsStore', () => {
    it('reads the list of an agent once, however many ask', async () => {
        const reads: string[] = [];
        const store = new ModelsStore({ getAgentModels: async (agentId: string) => (reads.push(agentId), answer('opus')) } as unknown as Transport);
        const list = store.of('claude');

        expect(list.status).toBe('idle');
        await Promise.all([list.load(), list.load()]);
        await list.load();

        expect(reads).toEqual(['claude']);
        expect(list.status).toBe('ready');
        expect(list.models?.models.map(model => model.id)).toEqual(['opus']);
        expect(store.of('claude')).toBe(list);
    });

    it('lets a second caller wait for the read that is already under way, instead of ending before the list is there', async () => {
        const { transport, asked } = slowTransport();
        const list = new ModelsStore(transport).of('claude');
        const first = list.load();
        const second = list.load();

        expect(asked).toHaveLength(1);
        expect(await ended(second)).toBe(false);

        asked[0].release(answer('opus'));
        await second;

        expect(list.models?.models.map(model => model.id)).toEqual(['opus']);
        await first;
    });

    it('keeps an answer that says the agent cannot list its models, and tries again after a failed request', async () => {
        let fail = true;
        const store = new ModelsStore({
            getAgentModels: async () => {
                if (fail) throw new Error('The daemon is away');

                return { state: 'unavailable', models: [], detail: 'Not installed' };
            },
        } as unknown as Transport);
        const list = store.of('cursor');

        await list.load();
        expect(list).toMatchObject({ status: 'failed', error: 'The daemon is away' });

        fail = false;
        await list.load();

        expect(list.status).toBe('ready');
        expect(list.models).toMatchObject({ state: 'unavailable', detail: 'Not installed' });
    });

    it('reads a list again when asked after an answer that gave no models, and leaves one that has models alone', async () => {
        const answers: AgentModels[] = [
            { state: 'unavailable', models: [], detail: 'Not installed' },
            { state: 'error', models: [], detail: 'Cursor is not signed in' },
            answer('opus'),
        ];
        const getAgentModels = vi.fn(async () => answers.shift()!);
        const list = new ModelsStore({ getAgentModels } as unknown as Transport).of('cursor');

        await list.load();
        expect(list.models).toMatchObject({ state: 'unavailable', detail: 'Not installed' });

        await list.load();
        expect(list.models).toMatchObject({ state: 'error', detail: 'Cursor is not signed in' });

        await list.load();
        expect(list).toMatchObject({ status: 'ready', models: { state: 'ok' } });

        await Promise.all([list.load(), list.load()]);
        expect(getAgentModels).toHaveBeenCalledTimes(3);
    });

    it('never reads twice at once when several ask after a read that gave no models, and reads nothing on its own', async () => {
        const { transport, asked } = slowTransport();
        const list = new ModelsStore(transport).of('cursor');
        const first = list.load();

        asked[0].release({ state: 'unavailable', models: [], detail: 'Not installed' });
        await first;

        const second = list.load();
        const third = list.load();

        expect(asked).toHaveLength(2);
        expect(await ended(third)).toBe(false);

        asked[1].release(answer('opus'));
        await Promise.all([second, third]);

        expect(list.models?.models.map(model => model.id)).toEqual(['opus']);

        // Nobody asked again, so nothing was read again: a retry is a question, never a loop.
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(asked).toHaveLength(2);
    });

    it('says what a rejection that is not an Error says', async () => {
        const list = new ModelsStore({ getAgentModels: async () => Promise.reject('offline') } as unknown as Transport).of('codex');

        await list.load();

        expect(list).toMatchObject({ status: 'failed', error: 'offline' });
    });

    it('shows the list it had while a newer one is on its way, and the newest request wins', async () => {
        const { transport, asked } = slowTransport();
        const list = new ModelsStore(transport).of('codex');
        const first = list.load();

        asked[0].release(answer('old'));
        await first;

        const slow = list.reload();
        const fast = list.reload();

        expect(list.status).toBe('loading');
        expect(list.models?.models[0].id).toBe('old');

        asked[2].release(answer('new'));
        await fast;
        asked[1].release(answer('stale'));
        await slow;

        expect(list.status).toBe('ready');
        expect(list.models?.models[0].id).toBe('new');
    });

    it('ends a replaced reload only when the newest one has, so nobody is released by an answer that no longer counts', async () => {
        const { transport, asked } = slowTransport();
        const list = new ModelsStore(transport).of('codex');
        const slow = list.reload();
        const fast = list.reload();

        asked[0].release(answer('stale'));

        expect(await ended(slow)).toBe(false);
        expect(list.status).toBe('loading');
        expect(list.models).toBeUndefined();

        asked[1].release(answer('new'));
        await Promise.all([slow, fast]);

        expect(list.models?.models[0].id).toBe('new');
    });

    it('ignores a replaced request that fails, and a replaced one that succeeds after the newest failed', async () => {
        const { transport, asked } = slowTransport();
        const list = new ModelsStore(transport).of('codex');
        const first = list.reload();
        const second = list.reload();

        asked[1].release(answer('new'));
        await second;
        asked[0].fail(new Error('late failure'));
        await first;

        expect(list).toMatchObject({ status: 'ready', error: '' });
        expect(list.models?.models[0].id).toBe('new');

        const third = list.reload();
        const fourth = list.reload();

        asked[3].fail(new Error('newest failed'));
        await fourth;
        asked[2].release(answer('older'));
        await third;

        expect(list).toMatchObject({ status: 'failed', error: 'newest failed' });
        expect(list.models?.models[0].id).toBe('new');
    });

    it('reloads only the lists that were opened, once each, and the newest answer wins when one was still loading', async () => {
        const { transport, asked } = slowTransport();
        const store = new ModelsStore(transport);
        const claude = store.of('claude');

        store.of('codex');

        const opening = claude.load();
        const reloading = store.reloadOpened();

        expect(asked.map(read => read.agentId)).toEqual(['claude', 'claude']);

        asked[1].release(answer('after the change'));
        asked[0].release(answer('before the change'));
        await Promise.all([opening, reloading]);

        expect(claude.models?.models[0].id).toBe('after the change');
        expect(store.of('codex').status).toBe('idle');
    });
});

describe('the models the root store reloads', () => {
    const stores: RootStore[] = [];

    afterEach(() => {
        stores.splice(0).forEach(root => root.dispose());
    });

    function make(getAgentModels: Transport['getAgentModels']) {
        const root = new RootStore(overrideTransport(new FixtureTransport(), { getAgentModels }), { storage: { getItem: () => null, setItem: () => undefined } });

        stores.push(root);

        return root;
    }

    it('reads the opened lists once when the daemon announces the change for every project', async () => {
        const getAgentModels = vi.fn(async () => answer('opus'));
        const root = make(getAgentModels);

        await root.models.of('claude').load();
        root.models.of('codex');
        getAgentModels.mockClear();

        root.handleEvent({ cursor: 1, at: 0, projectId: 'p-car', data: { type: 'agents.changed' } });
        root.handleEvent({ cursor: 2, at: 0, projectId: 'p-clowdy', data: { type: 'agents.changed' } });
        root.handleEvent({ cursor: 3, at: 0, projectId: 'p-car', data: { type: 'notice', level: 'info', text: 'x' } });

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(getAgentModels.mock.calls).toEqual([['claude']]);
    });

    describe('useAgentModels', () => {
        let shown: AgentModelList | undefined;

        function Probe({ agentId }: { agentId: string | undefined }): ReactNode {
            shown = useAgentModels(agentId);

            return null;
        }

        /** Mounts a `Probe` the way a component that asks for a list would be, and gives back what shows it again or removes it. */
        function mount(root: RootStore) {
            const dom = createRoot(document.createElement('div'));

            return {
                show: (agentId: string | undefined) => act(async () => dom.render(createElement(RootStoreProvider, { value: root }, createElement(Probe, { agentId })))),
                unmount: () => act(async () => dom.unmount()),
            };
        }

        it('reads the list when a component first asks, once however often one comes back, and not at all without an agent', async () => {
            const getAgentModels = vi.fn(async () => answer('opus'));
            const root = make(getAgentModels);
            const first = mount(root);

            await first.show('claude');

            expect(shown).toBe(root.models.of('claude'));
            expect(shown?.status).toBe('ready');
            expect(getAgentModels).toHaveBeenCalledTimes(1);
            await first.unmount();

            const second = mount(root);

            await second.show('claude');
            expect(getAgentModels).toHaveBeenCalledTimes(1);
            await second.show(undefined);
            expect(shown).toBeUndefined();
            await second.unmount();

            await mount(root).show(undefined);
            expect(getAgentModels).toHaveBeenCalledTimes(1);
        });
    });
});

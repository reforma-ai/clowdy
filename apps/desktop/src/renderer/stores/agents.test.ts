import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { RootStore } from './RootStore';

import type { AgentInfo } from '@clowdy/protocol';

const storage = { getItem: () => null, setItem: () => undefined };
const stores: RootStore[] = [];

function make(overrides: ConstructorParameters<typeof Object>[0] = {}) {
    const base = new FixtureTransport();
    const transport = overrideTransport(base, overrides);
    const root = new RootStore(transport, { storage });

    stores.push(root);

    return { root, base };
}

afterEach(() => {
    stores.splice(0).forEach(root => root.dispose());
});

describe('RootStore agents', () => {
    it('loads the agents at start', async () => {
        const { root } = make();

        expect(root.agentsStatus).toBe('loading');

        await root.load();
        await vi.waitFor(() => expect(root.agentsStatus).toBe('ready'));

        expect(root.agents.map(agent => agent.id)).toEqual(['claude', 'codex', 'cursor']);
    });

    it('fetches again once when the daemon announces a change for every project', async () => {
        const getAgents = vi.fn(async () => [] as AgentInfo[]);
        const { root } = make({ getAgents });

        await root.refreshAgents();
        getAgents.mockClear();

        root.handleEvent({ cursor: 1, at: 0, projectId: 'p-car', data: { type: 'agents.changed' } });
        root.handleEvent({ cursor: 2, at: 0, projectId: 'p-clowdy', data: { type: 'agents.changed' } });
        root.handleEvent({ cursor: 3, at: 0, projectId: 'p-car', data: { type: 'notice', level: 'info', text: 'x' } });

        await vi.waitFor(() => expect(getAgents).toHaveBeenCalledTimes(1));
    });

    it('shows what a command changed, through the event the daemon announces', async () => {
        const { root } = make();

        await root.load();
        await vi.waitFor(() => expect(root.agentsStatus).toBe('ready'));

        const result = await root.command({ type: 'agent.update', id: 'cursor', enabled: false });

        expect(result.ok).toBe(true);
        await vi.waitFor(() => expect(root.agents.find(agent => agent.id === 'cursor')?.enabled).toBe(false));
    });

    it('keeps the list it had when a fetch fails, and says so', async () => {
        const getAgents = vi.fn<() => Promise<AgentInfo[]>>();
        const { root, base } = make({ getAgents });

        getAgents.mockResolvedValueOnce(await base.getAgents());
        await root.refreshAgents();
        getAgents.mockRejectedValueOnce(new Error('offline'));
        await root.refreshAgents();

        expect(root.agentsStatus).toBe('failed');
        expect(root.agentsError).toBe('offline');
        expect(root.agents).toHaveLength(3);

        getAgents.mockResolvedValueOnce([]);
        await root.refreshAgents();

        expect([root.agentsStatus, root.agentsError, root.agents]).toEqual(['ready', '', []]);
    });

    it('lets the newest request win when an old one answers late', async () => {
        const answers: Array<(agents: AgentInfo[]) => void> = [];
        const getAgents = vi.fn(() => new Promise<AgentInfo[]>(resolve => answers.push(resolve)));
        const { root, base } = make({ getAgents });
        const everything = await base.getAgents();
        const first = root.refreshAgents();
        const second = root.refreshAgents();

        answers[1]!(everything.slice(0, 1));
        await second;
        answers[0]!(everything);
        await first;

        expect(root.agents.map(agent => agent.id)).toEqual(['claude']);
    });
});

import { createFixtureData, type FixtureData } from '../../daemon/fixtureData';
import { ModelsStore } from '../../stores';

import type { AgentModels } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

export interface ModelStoreOptions {
    /** Changes the fixture's agents and the model lists they answer with, before the store is made. */
    change?: (data: FixtureData) => void;
    /** What reads a list, given the fixture's answer for it; without it the fixture's answer is the answer. */
    read?: (agentId: string, fixture: AgentModels) => Promise<AgentModels>;
    /** Read the lists of the agents that are on before returning, as the app has them once it has drawn the picker (default), or leave that to the first draw. */
    preload?: boolean;
    /** The agents have not been read yet, as in the first moments of the app: none are known and their status is `loading`. */
    agentsLoading?: boolean;
}

/**
 * For the tests of the model picker: the part of the root store the picker reads (the agents and their models), on the fixture
 * daemon's three agents. The tests have no MobX observer, so the lists are read up front and a test that reads them later draws again.
 */
export async function modelStore({ change, read, preload = true, agentsLoading = false }: ModelStoreOptions = {}) {
    const data = createFixtureData();

    change?.(data);

    const fixture = (agentId: string): AgentModels =>
        structuredClone(data.agentModels[agentId] ?? { state: 'unavailable' as const, models: [] });
    const transport = {
        getAgentModels: async (agentId: string) => (read ? read(agentId, fixture(agentId)) : fixture(agentId)),
    } as unknown as Transport;
    const models = new ModelsStore(transport);

    if (preload)
        await Promise.all(
            data.agents
                .filter(agent => agent.enabled && agent.status === 'ready')
                .map(agent => models.of(agent.id).load())
        );

    return {
        agents: agentsLoading ? [] : data.agents,
        agentsStatus: agentsLoading ? ('loading' as const) : ('ready' as const),
        agentsError: '',
        models,
    };
}

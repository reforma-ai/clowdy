import { listProjects } from '../db/projects';
import { AgentRegistryError } from '../engine/acp/registry';
import { conflict, invalid, notFound } from '../errors';

import type { Handlers, Services } from './context';

/** Runs a change to the agents, turning the registry's refusals into command errors, and tells every project's clients to refetch. */
function change<T>(services: Services, id: string | undefined, apply: () => T): T {
    try {
        const result = apply();

        for (const project of listProjects(services.store.db)) {
            services.store.emit(project.id, { type: 'agents.changed' });
        }

        return result;
    }
    catch (error) {
        if (error instanceof AgentRegistryError) {
            throw error.kind === 'not_found' ? notFound('Agent', id ?? '') : error.kind === 'conflict' ? conflict(error.message) : invalid(error.message);
        }

        throw error;
    }
}

export const agentsHandlers: Pick<Handlers, 'agent.add' | 'agent.update' | 'agent.remove' | 'agents.refresh' | 'agent.signIn' | 'agent.cancelSignIn'> = {
    'agent.add': (services, { id, name, command, args, env }) => change(services, id, () => {
        services.agents.add({ id, name, command, args: args ?? [], ...(env && { env }) });

        return { id };
    }),
    'agent.update': (services, { id, enabled, path, env, name, command, args }) => change(services, id, () => {
        services.agents.update(id, { enabled, path, env, name, command, args });
        // Another program, environment or switch can mean another account: read it again.
        services.providers.forget(id);

        return { id };
    }),
    'agent.remove': (services, { id }) => change(services, id, () => {
        services.agents.remove(id);

        return { id };
    }),
    'agent.signIn': (_services, { id }) => {
        throw invalid(`Signing in to ${ id } from Clowdy is not available yet`);
    },
    'agent.cancelSignIn': (_services, { id }) => ({ id }),
    'agents.refresh': services => change(services, undefined, () => {
        services.agents.refresh();
        services.providers.refresh();

        return {};
    }),
};

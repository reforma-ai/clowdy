import { AgentRegistryError } from '../engine/acp/registry';
import { conflict, invalid, notFound } from '../errors';
import { announceAgentsChanged } from '../providers/announce';
import { SignInError } from '../providers/login';

import type { Handlers, Services } from './context';

/** Runs a change to the agents, turning the registry's refusals into command errors, and tells every project's clients to refetch. */
function change<T>(services: Services, id: string | undefined, apply: () => T): T {
    try {
        const result = apply();

        announceAgentsChanged(services.store);

        return result;
    } catch (error) {
        if (error instanceof AgentRegistryError) {
            throw error.kind === 'not_found'
                ? notFound('Agent', id ?? '')
                : error.kind === 'conflict'
                  ? conflict(error.message)
                  : invalid(error.message);
        }

        throw error;
    }
}

export const agentsHandlers: Pick<
    Handlers,
    | 'agent.add'
    | 'agent.update'
    | 'agent.remove'
    | 'agents.refresh'
    | 'agent.signIn'
    | 'agent.cancelSignIn'
    | 'agents.setCommitMessageProvider'
    | 'agents.setSharedSetting'
> = {
    'agent.add': (services, { id, name, command, args, env }) =>
        change(services, id, () => {
            services.agents.add({ id, name, command, args: args ?? [], ...(env && { env }) });

            return { id };
        }),
    'agent.update': (services, { id, enabled, path, env, name, command, args, settings, permission }) =>
        change(services, id, () => {
            services.agents.update(id, { enabled, path, env, name, command, args, settings, permission });
            // Another program, environment or switch can mean another account: read it again. A setting cannot, but it can change the models on offer.
            if (enabled !== undefined || path !== undefined || env !== undefined) {
                services.providers.forget(id);
            }

            if (enabled !== undefined || path !== undefined || env !== undefined || settings !== undefined) {
                services.models.forget(id);
            }

            return { id };
        }),
    'agent.remove': (services, { id }) =>
        change(services, id, () => {
            services.agents.remove(id);

            return { id };
        }),
    'agents.setSharedSetting': (services, { id, enabled }) =>
        change(services, undefined, () => {
            services.agents.setSharedSetting(id, enabled);
            return { id, enabled };
        }),
    'agents.setCommitMessageProvider': (services, { provider }) =>
        change(services, undefined, () => {
            services.agents.setCommitMessageProvider(provider);

            return { provider };
        }),
    'agent.signIn': (services, { id }) => {
        try {
            services.providers.signIn(id);
        } catch (error) {
            if (error instanceof SignInError) {
                throw error.kind === 'conflict' ? conflict(error.message) : invalid(error.message);
            }

            throw error;
        }

        return { id };
    },
    'agent.cancelSignIn': (services, { id }) => {
        services.providers.cancelSignIn(id);

        return { id };
    },
    'agents.refresh': services =>
        change(services, undefined, () => {
            services.agents.refresh();
            services.providers.refresh();
            services.models.forget();

            return {};
        }),
};

import { toast } from '@clowdy/components/Toast';
import { useCallback, useState } from 'react';

import { useRootStore } from '../../../stores';

import type { CommandInput } from '../../../daemon/transport';

/**
 * The commands a provider card sends for one agent. Each reports a refusal as a toast, and is `pending` from the press until
 * the agents were fetched again, so a switch never jumps back to its old value before the new one arrives.
 */
export function useAgentCommands(agentId: string) {
    const root = useRootStore();
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

    const send = useCallback(async (key: string, input: CommandInput): Promise<boolean> => {
        setPending(keys => new Set(keys).add(key));

        const result = await root.command(input);

        if (result.ok) await root.refreshAgents();
        else toast.error({ message: result.error.message });

        setPending((keys) => {
            const rest = new Set(keys);

            rest.delete(key);

            return rest;
        });

        return result.ok;
    }, [root]);

    return {
        pending,
        setEnabled: (enabled: boolean) => send('enabled', { type: 'agent.update', id: agentId, enabled }),
        setSetting: (settingId: string, value: boolean) => send(`setting:${ settingId }`, { type: 'agent.update', id: agentId, settings: { [settingId]: value } }),
        /** `null` goes back to looking for the program. */
        setPath: (path: string | null) => send('path', { type: 'agent.update', id: agentId, path }),
        /** Replaces the variables saved for the agent. */
        setEnv: (env: Record<string, string>) => send('env', { type: 'agent.update', id: agentId, env }),
        signIn: () => send('signIn', { type: 'agent.signIn', id: agentId }),
        cancelSignIn: () => send('cancelSignIn', { type: 'agent.cancelSignIn', id: agentId }),
        refresh: () => send('refresh', { type: 'agents.refresh' }),
    };
}

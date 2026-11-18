import { toast } from '@clowdy/components/Toast';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRootStore } from '../../../stores';

import type { CommandInput } from '../../../daemon/transport';

/** How often the agents are fetched while a read that was asked for is on its way, and when the wait is given up. */
const READ_POLL_MS = 1_500;
const READ_GIVE_UP_MS = 30_000;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The commands a provider card sends for one agent. Each reports a refusal as a toast, and is `pending` from the press until
 * the agents were fetched again, so a switch never jumps back to its old value before the new one arrives.
 */
export function useAgentCommands(agentId: string) {
    const root = useRootStore();
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const isMounted = useRef(true);

    useEffect(() => {
        isMounted.current = true;

        return () => {
            isMounted.current = false;
        };
    }, []);

    /** Sends `input`; `settle` runs after the agents were fetched and keeps the key pending until it ends. */
    const send = useCallback(async (key: string, input: CommandInput, settle?: () => Promise<void>): Promise<boolean> => {
        setPending(keys => new Set(keys).add(key));

        const result = await root.command(input);

        if (result.ok) {
            await root.refreshAgents();
            await settle?.();
        }
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
        /**
         * The daemon reads in the background and answers at once, so the new numbers are not in the answer. The button spins
         * until the agent's last read (`signIn.checkedAt`, which every read moves, a failed one too) is a newer one.
         */
        refresh: () => {
            const lastRead = () => root.agents.find(agent => agent.id === agentId)?.signIn?.checkedAt;
            const before = lastRead();
            const giveUpAt = Date.now() + READ_GIVE_UP_MS;

            return send('refresh', { type: 'agents.refresh' }, async () => {
                while (isMounted.current && lastRead() === before && Date.now() < giveUpAt) {
                    await wait(READ_POLL_MS);
                    await root.refreshAgents();
                }
            });
        },
    };
}

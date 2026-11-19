import type { AgentInfo, Chat, EngineId, Run } from '@clowdy/protocol';

/** The scripted demo agent. It is not a program on this machine, so the agents list does not have it, and it can always answer. */
const SCRIPTED_ENGINE: EngineId = 'fake';

/** Why a chat cannot be written to. */
export type ReadOnlyReason = 'unknown' | 'disabled' | 'not-installed' | 'needs-runtime' | 'signed-out';

export type ChatWritability =
    | { writable: true }
    | {
        writable: false;
        reason: ReadOnlyReason;
        /** Says what is wrong, for the person: `Claude Code is turned off in Clowdy`. */
        message: string;
    };

const WRITABLE: ChatWritability = { writable: true };

/** The agent a chat runs on: its own `engine`, or the one its orchestrator runs on for a chat from before the chat kept one. */
export function chatProvider(chat: Chat, run: Run | undefined): EngineId | undefined {
    return chat.engine ?? run?.engine;
}

/** Whether the chat's agent has a command that compacts its conversation (`AgentInfo.canCompact`), which is what Compact is offered for. */
export function canCompactChat(chat: Chat, run: Run | undefined, agents: readonly AgentInfo[]): boolean {
    const engine = chatProvider(chat, run);

    return engine !== undefined && agents.some(agent => agent.id === engine && agent.canCompact === true);
}

/**
 * Whether the chat's agent takes a message while it works (`AgentInfo.canSteer`), which is what Send now does for it: the turn reads the message at once. For
 * one that does not (Cursor) Send now stops what the agent is doing and sends the message as its next turn. An agent the list does not have yet (it is still
 * loading, or it is the scripted demo agent) counts as one that can: the daemon decides what Send now does, and the button keeps its plain name until the list says otherwise.
 */
export function canSteerChat(chat: Chat, run: Run | undefined, agents: readonly AgentInfo[]): boolean {
    const engine = chatProvider(chat, run);
    const agent = engine === undefined ? undefined : agents.find(candidate => candidate.id === engine);

    return agent === undefined || agent.canSteer === true;
}

/**
 * Whether a message can be sent to the chat now, and when not why. The provider is fixed by the first message, so only a chat that
 * has an orchestrator can be stuck on one that cannot run; before that the picker may still change it. Whatever is not known yet
 * counts as writable, so the notice never flashes while the agents load, while an account is still being read, or for a chat
 * whose provider cannot be told: the daemon refuses a message that cannot go anyway.
 */
export function chatWritability(
    chat: Chat,
    run: Run | undefined,
    agents: readonly AgentInfo[],
    agentsStatus: 'loading' | 'ready' | 'failed'
): ChatWritability {
    const engine = chatProvider(chat, run);

    if (!chat.orchestratorRunId || !engine || engine === SCRIPTED_ENGINE || agentsStatus !== 'ready') return WRITABLE;

    const agent = agents.find(candidate => candidate.id === engine);

    if (!agent) {
        return { writable: false, reason: 'unknown', message: `This chat ran on "${ engine }", which Clowdy no longer has` };
    }

    // The daemon reports a switched-off agent as `disabled` whether or not its program is installed.
    if (agent.status === 'disabled' || !agent.enabled) {
        return { writable: false, reason: 'disabled', message: `${ agent.name } is turned off in Clowdy` };
    }

    if (agent.status === 'missing') {
        return { writable: false, reason: 'not-installed', message: `${ agent.name } is not installed` };
    }

    if (agent.status === 'needs-runtime') {
        return { writable: false, reason: 'needs-runtime', message: `${ agent.name } needs Bun to start` };
    }

    // `unknown` and an account not read yet are no reason to hold the person back.
    if (agent.signIn?.status === 'signed-out') {
        return { writable: false, reason: 'signed-out', message: `${ agent.name } is not signed in` };
    }

    return WRITABLE;
}

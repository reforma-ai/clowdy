import { agentRowLabel } from '../features/chats/runningAgentRows';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * How the app names a run to the person. A chat's orchestrator reads as the chat's title: its own `name` is the daemon's number (`Orchestrator 41`), which
 * tells the person nothing. A native sub-agent reads as its type (`General agent`), the same in its card, the running-agents row and its page. A run no chat
 * answers to (the chat is gone) keeps its `name`.
 */
export function runLabel(run: Pick<Run, 'id' | 'name' | 'origin'>, chats: Iterable<Chat>): string {
    if (run.origin === 'native') return agentRowLabel(run);

    for (const chat of chats) {
        if (chat.orchestratorRunId === run.id && chat.title.trim() !== '') return chat.title;
    }

    return run.name;
}

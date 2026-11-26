import { agentRowLabel } from '../features/chats/runningAgentRows';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * How the app names a run to the person. A chat's orchestrator reads as the chat's title: its own `name` is the daemon's number (`Orchestrator 41`), which
 * tells the person nothing. A native sub-agent reads as what it was asked to do (its summary, else its type), the same in its card, the running-agents row, the list and its page.
 * A chat's orchestrator keeps no summary worth showing: the daemon sets it to the chat's title at the first message and never changes it, so a rename would leave the old
 * title beside the new one. A run no chat answers to (the chat is gone) keeps its `name`.
 */
export function runLabel(run: Pick<Run, 'id' | 'name' | 'summary' | 'origin'>, chats: Iterable<Chat>): string {
    if (run.origin === 'native') return agentRowLabel(run);

    for (const chat of chats) {
        if (chat.orchestratorRunId === run.id && chat.title.trim() !== '') return chat.title;
    }

    return run.name;
}

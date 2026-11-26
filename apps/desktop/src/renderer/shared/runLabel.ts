import { agentRowLabel } from '../features/chats/runningAgentRows';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * The line that says what a run does, for a tooltip or under its name: a native sub-agent's own summary. A chat's orchestrator has none to show: the daemon sets its
 * summary to the chat's title when the first message starts it and never changes it, so after a rename it would print the old title beside the new one.
 */
export function runSummary(run: Pick<Run, 'origin' | 'summary'>): string | undefined {
    return run.origin === 'native' && run.summary.trim() !== '' ? run.summary : undefined;
}

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

import { setRunArchived } from '../domain/runArchive';

import type { Handlers } from './context';

export const runHandlers: Pick<
    Handlers,
    'run.cancel' | 'run.setArchived' | 'run.stopAgents' | 'run.stopBackground' | 'run.answer' | 'run.decide'
> = {
    /** Stopping a chat's orchestrator holds its queue: what the person wrote for the stopped work waits until they send it. */
    'run.cancel': ({ runs, queue }, command) => {
        const cancelled = runs.cancel(command.runId);
        const { chatId } = runs.require(command.runId);

        if (chatId && cancelled.includes(command.runId)) {
            queue.pause(chatId, 'stopped');
        }

        return { cancelled };
    },

    /** Puts a native sub-agent away, or brings it back; archiving takes the sub-agents it started along (`setRunArchived`). */
    'run.setArchived': ({ store }, command) => ({ run: setRunArchived(store, command.runId, command.archived) }),

    /** The run goes on and its queue is not held: only the agents below it stop (`RunService.stopAgents`). */
    'run.stopAgents': ({ runs }, command) => ({ stopped: runs.stopAgents(command.runId) }),

    /** One background command stops and everything else goes on, the run and its queue included (`RunService.stopBackground`). */
    'run.stopBackground': ({ runs }, command) => ({ stopped: runs.stopBackground(command.runId, command.itemId) }),

    'run.answer': ({ runs }, command) => {
        runs.answerQuestion(command.runId, command.questionId, command.answer);

        return { runId: command.runId };
    },

    /** Decides an approval of the run (`RunService.decide`); the agent's request goes on as the decision says. */
    'run.decide': ({ runs }, command) => {
        runs.decide(command.runId, command.approvalId, command.decision);

        return { runId: command.runId };
    },
};

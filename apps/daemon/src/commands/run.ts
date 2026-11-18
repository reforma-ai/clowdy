import type { Handlers } from './context';

export const runHandlers: Pick<Handlers, 'run.cancel' | 'run.answer'> = {
    /** Stopping a chat's orchestrator holds its queue: what the person wrote for the stopped work waits until they send it. */
    'run.cancel': ({ runs, queue }, command) => {
        const cancelled = runs.cancel(command.runId);
        const { chatId } = runs.require(command.runId);

        if (chatId && cancelled.includes(command.runId)) {
            queue.pause(chatId, 'stopped');
        }

        return { cancelled };
    },

    'run.answer': ({ runs }, command) => {
        runs.answerQuestion(command.runId, command.questionId, command.answer);

        return { runId: command.runId };
    },
};

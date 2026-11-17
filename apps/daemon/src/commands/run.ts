import type { Handlers } from './context';

export const runHandlers: Pick<Handlers, 'run.cancel' | 'run.answer'> = {
    'run.cancel': ({ runs }, command) => ({ cancelled: runs.cancel(command.runId) }),

    'run.answer': ({ runs }, command) => {
        runs.answerQuestion(command.runId, command.questionId, command.answer);

        return { runId: command.runId };
    },
};

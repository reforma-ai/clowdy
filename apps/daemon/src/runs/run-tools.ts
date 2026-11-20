import { z } from 'zod';

import { defineTool } from './tool-kit';

import type { Run } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

export const ASK_USER = 'ask_user';

/** Semi-manual orchestrators ask the user through a question card and wait for the answer. */
export function askUserTool({ runs }: ToolDeps, run: Run): ToolDefinition {
    return defineTool(ASK_USER, 'Asks the user one question and waits for the answer. Offer concrete options a manager can weigh, and mark the one you recommend. Only for significant forks; decide routine things yourself.', z.object({
        question: z.string().min(1),
        options: z.array(z.object({ id: z.string(), label: z.string(), consequence: z.string().optional() })).min(1),
        recommended: z.string().optional().describe('The id of the option you recommend'),
    }), async (input, signal) => {
        const answer = await runs.ask(run.id, { text: input.question, options: input.options, recommended: input.recommended }, signal);
        const option = input.options.find(candidate => candidate.id === answer);

        return { answer: option?.label ?? answer };
    });
}

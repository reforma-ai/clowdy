import { z } from 'zod';

import type { QuestionOption } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { RunService } from './service';
import type { ThreadService } from './threads';

export interface ToolDeps {
    store: Store;
    runs: RunService;
    threads: ThreadService;
    pauseQuestion?: (
        runId: string,
        question: { text: string; options: QuestionOption[]; recommended?: string }
    ) => void;
}

/**
 * A tool with a zod schema: the model's input is checked first and a bad call answers with what to fix. `options.cli` marks a tool that is also a
 * shell command (`ToolDefinition.cli`).
 */
export function defineTool<Schema extends z.ZodType>(
    name: string,
    description: string,
    schema: Schema,
    run: (input: z.infer<Schema>, signal: AbortSignal) => Promise<unknown> | unknown,
    options: Pick<ToolDefinition, 'cli'> = {}
): ToolDefinition {
    return {
        name,
        description,
        inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
        schema,
        ...(options.cli && { cli: options.cli }),
        async execute(input, signal) {
            const parsed = schema.safeParse(input);

            if (!parsed.success) {
                throw new Error(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
            }

            return run(parsed.data, signal);
        },
    };
}

/** A task is named by its key (`CLW-3`) in everything the models read and write; ids work too. */
export const taskRef = z.string().min(1).describe('A task key such as CLW-3 (an id also works)');

/**
 * The first `length` UTF-16 units of `text`, one fewer when the cut would split a character such as an emoji in two: a lone half is not valid text, and
 * a strict JSON reader on the agent's side refuses the whole tool result over it.
 */
export function cut(text: string, length: number): string {
    const last = text.charCodeAt(length - 1);

    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

export const clip = (text: string, limit: number) => (text.length > limit ? `${cut(text, limit - 1)}…` : text);

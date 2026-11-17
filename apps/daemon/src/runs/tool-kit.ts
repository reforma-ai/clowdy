import { z } from 'zod';

import type { ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { RunDriver } from './driver';
import type { RunService } from './service';

export interface ToolDeps {
    store: Store;
    runs: RunService;
    driver: RunDriver;
}

/** A tool with a zod schema: the model's input is checked first and a bad call answers with what to fix. */
export function defineTool<Schema extends z.ZodType>(
    name: string,
    description: string,
    schema: Schema,
    run: (input: z.infer<Schema>, signal: AbortSignal) => Promise<unknown> | unknown
): ToolDefinition {
    return {
        name,
        description,
        inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
        schema,
        async execute(input, signal) {
            const parsed = schema.safeParse(input);

            if (!parsed.success) {
                throw new Error(`Invalid input for ${ name }: ${ z.prettifyError(parsed.error) }`);
            }

            return run(parsed.data, signal);
        },
    };
}

/** A task is named by its key (`CLW-3`) in everything the models read and write; ids work too. */
export const taskRef = z.string().min(1).describe('A task key such as CLW-3 (an id also works)');

export const clip = (text: string, limit: number) => (text.length > limit ? `${ text.slice(0, limit - 1) }…` : text);

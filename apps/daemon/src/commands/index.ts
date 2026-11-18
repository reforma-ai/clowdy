import { CommandError, errorMessage } from '../errors';
import { agentsHandlers } from './agents';
import { chatHandlers } from './chat';
import { docsHandlers } from './docs';
import { projectHandlers } from './project';
import { runHandlers } from './run';
import { skillsHandlers } from './skills';
import { taskHandlers } from './task';

import type { Command, CommandResult } from '@clowdy/protocol';
import type { Handlers, Services } from './context';

export type { Services } from './context';

const handlers: Handlers = { ...projectHandlers, ...chatHandlers, ...taskHandlers, ...runHandlers, ...docsHandlers, ...skillsHandlers, ...agentsHandlers };

/**
 * Runs a command. The first result for a `requestId` (success or a caller error) is stored in the same transaction
 * as the effects and returned again for a repeat, so a retried command never acts twice. A command that fails rolls
 * back completely. Unexpected errors are reported as `internal` and not remembered, so a retry may succeed.
 */
export function executeCommand(services: Services, command: Command): CommandResult {
    const { store } = services;
    const prior = store.commandResult(command.requestId);

    if (prior) {
        return prior;
    }

    const handler = handlers[command.type] as (services: Services, command: Command) => unknown;

    try {
        return store.tx(() => {
            const result: CommandResult = { ok: true, requestId: command.requestId, data: handler(services, command) };

            store.saveCommandResult(result);

            return result;
        });
    }
    catch (error) {
        if (error instanceof CommandError) {
            const result: CommandResult = { ok: false, requestId: command.requestId, error: { code: error.code, message: error.message, ...(error.details !== undefined && { details: error.details }) } };

            store.tx(() => store.saveCommandResult(result));

            return result;
        }

        console.error(`[clowdy] command ${ command.type } failed unexpectedly:`, error);

        return { ok: false, requestId: command.requestId, error: { code: 'internal', message: errorMessage(error) } };
    }
}

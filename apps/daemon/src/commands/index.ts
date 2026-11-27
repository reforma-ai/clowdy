import { writeBranchPrefix } from '../db/appSettings';
import { CommandError, errorMessage } from '../errors';
import { agentsHandlers } from './agents';
import { chatAsyncHandlers, chatHandlers } from './chat';
import { projectHandlers } from './project';
import { runHandlers } from './run';
import { skillsHandlers } from './skills';
import { taskHandlers } from './task';
import { workspaceAsyncHandlers, workspaceHandlers } from './workspace';

import type { Command, CommandResult } from '@clowdy/protocol';
import type { Store } from '../store';
import type { AsyncHandlers, CommandOf, Handlers, Services, SometimesAsyncCommandType } from './context';

export type { Services } from './context';

const handlers: Handlers = {
    'settings.setBranchPrefix': ({ store }, { prefix }) => ({ prefix: writeBranchPrefix(store.db, prefix) }),
    ...projectHandlers,
    ...chatHandlers,
    ...taskHandlers,
    ...runHandlers,
    ...skillsHandlers,
    ...agentsHandlers,
    ...workspaceHandlers,
};
const asyncHandlers: AsyncHandlers = { ...chatAsyncHandlers, ...workspaceAsyncHandlers };

/**
 * When a command that has both kinds of handler takes the async one: a delete that removes the chat's worktree waits for git, a plain delete does not; so does a chat made with a
 * `workspace` (git reads the repository, or switches the folder's checkout, first), and a chat made in the folder as it is does not.
 */
const waitsWhen: { [T in SometimesAsyncCommandType]: (command: CommandOf<T>) => boolean } = {
    'chat.create': command => command.workspace !== undefined,
    'chat.delete': command => command.removeWorkspace === true,
};

/** Whether the command takes its `AsyncHandlers` entry: always for a command that has no other, and when `waitsWhen` says so for one that has. */
const isAsync = (command: Command): boolean =>
    command.type in asyncHandlers &&
    ((waitsWhen as Record<string, ((command: Command) => boolean) | undefined>)[command.type]?.(command) ?? true);

/** Whether the command waits (`AsyncHandlers`) for an agent or for git: its answer may take longer than the server's idle timeout lets a silent connection live. */
export const waitsForAgent = (command: Command): boolean => isAsync(command);

/** The async commands being run, by request id: a repeat that comes before the first has finished waits for it instead of acting twice. */
const flights = new WeakMap<Store, Map<string, Promise<CommandResult>>>();

/**
 * Runs `handler` in the transaction that also stores the command's result and returns that result: a command that fails rolls back completely, and a caller
 * error (`CommandError`) is remembered like a success; any other error is `internal` and is not, so a retry may succeed.
 */
function settle(services: Services, command: Command, handler: () => unknown): CommandResult {
    const { store } = services;

    try {
        return store.tx(() => {
            const result: CommandResult = { ok: true, requestId: command.requestId, data: handler() };

            store.saveCommandResult(result);

            return result;
        });
    } catch (error) {
        if (error instanceof CommandError) {
            const result: CommandResult = {
                ok: false,
                requestId: command.requestId,
                error: {
                    code: error.code,
                    message: error.message,
                    ...(error.details !== undefined && { details: error.details }),
                },
            };

            store.tx(() => store.saveCommandResult(result));

            return result;
        }

        console.error(`[clowdy] command ${command.type} failed unexpectedly:`, error);

        return { ok: false, requestId: command.requestId, error: { code: 'internal', message: errorMessage(error) } };
    }
}

/**
 * Runs a command that does not wait: every one but those of `AsyncHandlers`, which `executeCommandAsync` runs. The first result for a `requestId`
 * (success or a caller error) is stored in the same transaction as the effects and returned again for a repeat, so a retried command never acts twice.
 * A command that fails rolls back completely. Unexpected errors are reported as `internal` and not remembered, so a retry may succeed.
 */
export function executeCommand(services: Services, command: Command): CommandResult {
    const prior = services.store.commandResult(command.requestId);

    if (prior) {
        return prior;
    }

    if (isAsync(command)) {
        return {
            ok: false,
            requestId: command.requestId,
            error: {
                code: 'internal',
                message: `${command.type} waits for an agent or for git: run it with executeCommandAsync`,
            },
        };
    }

    const handler = (handlers as Record<string, (services: Services, command: Command) => unknown>)[command.type];

    return settle(services, command, () => handler(services, command));
}

/**
 * Runs any command. A command of `AsyncHandlers` waits first (outside any transaction), then changes the store and stores its result in one transaction, with
 * the rules of `executeCommand`; a refusal while it waited is a result like any other. The same `requestId` sent again while the first is still waiting is
 * answered with the first's result.
 */
export async function executeCommandAsync(services: Services, command: Command): Promise<CommandResult> {
    if (!isAsync(command)) {
        return executeCommand(services, command);
    }

    const { store } = services;
    const prior = store.commandResult(command.requestId);

    if (prior) {
        return prior;
    }

    const running = flights.get(store) ?? new Map<string, Promise<CommandResult>>();
    const waiting = running.get(command.requestId);

    if (waiting) {
        return waiting;
    }

    const handler = (asyncHandlers as Record<string, (services: Services, command: Command) => Promise<() => unknown>>)[
        command.type
    ];
    const flight = (async () => {
        let commit: () => unknown;

        try {
            commit = await handler(services, command);
        } catch (error) {
            commit = () => {
                throw error;
            };
        }

        return settle(services, command, commit);
    })().finally(() => running.delete(command.requestId));

    flights.set(store, running);
    running.set(command.requestId, flight);

    return flight;
}

import { askUserTool } from './run-tools';
import { orchestratorTaskTools } from './task-tools';
import { threadTools } from './thread-tools';

import type { ChatMode, Run } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

export { ASK_USER } from './run-tools';
export type { ToolDeps } from './tool-kit';

/**
 * The tools a run gets: every run the daemon drives is a chat's orchestrator. They act on the real task list and on the chat's threads: an orchestrator
 * reads, creates and changes tasks, starts and drives threads (`thread_*`, for a run with a chat), and asks the user (`ask_user`) only in semi-manual chats.
 */
export function toolsFor(deps: ToolDeps, run: Run, mode: ChatMode): ToolDefinition[] {
    return [...orchestratorTaskTools(deps, run), ...(run.chatId ? threadTools(deps, run) : []), ...(mode === 'semi' ? [askUserTool(deps, run)] : [])];
}

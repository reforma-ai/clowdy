import { askUserTool } from './run-tools';
import { orchestratorTaskTools } from './task-tools';
import { threadTools } from './thread-tools';
import { worktreeTools } from './worktree-tools';

import type { ChatMode, Run } from '@clowdy/protocol';
import type { TaskChannel } from '../engine/acp/catalog';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

export { ASK_USER } from './run-tools';

export type { ToolDeps } from './tool-kit';

/** The tool as an MCP tool: without `cli` the bridge lists it for the session's MCP server, not for the `clowdy` command. */
const asMcp = ({ cli: _shell, ...tool }: ToolDefinition): ToolDefinition => tool;

/**
 * The tools a run gets: every run the daemon drives is a chat's orchestrator. They act on the real task list and on the chat's threads: an orchestrator
 * reads, creates and changes tasks (`task_*`), starts and drives threads (`thread_*`, for a run with a chat), names the branch of its worktree once (`worktree_name`, for a chat
 * whose worktree is its own and whose branch has no name yet), and asks the user (`ask_user`) only in
 * semi-manual chats. The task tools are shell commands (`clowdy task`) for an agent that uses the `cli` door and MCP tools for one that uses `mcp`
 * (`AgentSpec.taskTools`); the thread tools are shell commands for every agent.
 */
export function toolsFor(deps: ToolDeps, run: Run, mode: ChatMode, taskChannel: TaskChannel = 'cli'): ToolDefinition[] {
    const tasks = orchestratorTaskTools(deps, run);

    return [
        ...(taskChannel === 'mcp' ? tasks.map(asMcp) : tasks),
        ...(run.chatId ? [...threadTools(deps, run), ...worktreeTools(deps, run)] : []),
        ...(mode === 'semi' ? [askUserTool(deps, run)] : []),
    ];
}

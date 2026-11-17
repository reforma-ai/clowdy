import { askUserTool, orchestratorRunTools, reportResultTool } from './run-tools';
import { orchestratorTaskTools, workerTaskTools } from './task-tools';

import type { ChatMode, Run } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

export { ASK_USER } from './run-tools';
export type { ToolDeps } from './tool-kit';

/**
 * The tools a run gets. They act on the real task list and run tree, which is what makes parent and child runs and the
 * many-to-many task links happen. An orchestrator creates and changes tasks and manages child runs (`ask_user` only in
 * semi-manual chats). Executors and verifiers read tasks, change their own, and end with `report_result`; they start nothing.
 */
export function toolsFor(deps: ToolDeps, run: Run, mode: ChatMode): ToolDefinition[] {
    if (run.role !== 'orchestrator') {
        return [...workerTaskTools(deps, run), reportResultTool(deps, run)];
    }

    return [...orchestratorTaskTools(deps, run), ...orchestratorRunTools(deps, run), ...(mode === 'semi' ? [askUserTool(deps, run)] : [])];
}

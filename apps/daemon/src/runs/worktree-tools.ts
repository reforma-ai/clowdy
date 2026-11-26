import { z } from 'zod';

import { getChat } from '../db/chats';
import { canNameBranch, nameWorkspaceBranch } from '../domain/workspaces';
import { defineTool } from './tool-kit';

import type { Run } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { ToolDeps } from './tool-kit';

/**
 * The worktree tools of a chat's orchestrator: for now one, `worktree_name` (`clowdy worktree name`), and only for a chat whose worktree Clowdy made for it and whose branch
 * has not a name of its own yet, so a chat that has no use for it has no such command. A new worktree is on `<prefix>/<chat id8>`, a branch name nobody reads; the agent knows
 * the work, so it gives the branch a name once, before it commits. The daemon renames the branch where it stands: the folder, the session and the rights of the agent are the same.
 */
export function worktreeTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const chat = run.chatId ? getChat(deps.store.db, run.chatId) : undefined;

    return chat && canNameBranch(chat) ? [worktreeNameTool(deps, run, chat.id)] : [];
}

/** `worktree_name` of the chat `chatId`, whether or not it can be called now (the call checks again): what `worktreeTools` offers, and what the help's examples are checked against. */
export function worktreeNameTool({ store, runs }: ToolDeps, run: Run, chatId: string): ToolDefinition {
    return defineTool(
        'worktree_name',
        'Gives the branch of your worktree a name made of the words you give, once: the placeholder it was made with (clowdy/<id>) is renamed where it stands (git branch -m), so your folder, your session and your commits are as they were, and the person sees the new name. Use it as soon as the first message tells you what the chat is about (a question or an investigation counts, not only edits) and always before your first commit, with two to four words in English that say it (fix-login-redirect). The prefix stays (clowdy/fix-login-redirect), and the end of your id is added when the name is taken. Refused when the branch has been pushed, or your worktree is on another branch than the one it was made with. Answers with the new name.',
        z.object({
            name: z
                .string()
                .min(1)
                .describe(
                    'Two to four English words that name the work, lower case, joined with dashes (fix-login-redirect); other letters and spaces become dashes, and words that are not in ASCII are dropped'
                ),
        }),
        input => {
            const current = getChat(store.db, chatId);

            if (!current) {
                throw new Error('This chat is gone');
            }

            const { branch, previous } = nameWorkspaceBranch(store, runs.projectOf(run), current, input.name);

            return {
                branch,
                previous,
                note: `The branch of your worktree is ${branch} now (it was ${previous}). Commit on it and use this name when you refer to it.`,
            };
        },
        { cli: { positional: ['name'] } }
    );
}

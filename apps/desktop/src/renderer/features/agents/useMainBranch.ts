import { toast } from '@clowdy/components/Toast';
import { useEffect, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { type GitPlaceKey, gitFactsOf } from '../changes/gitFacts';
import { useBranchSwitch } from '../changes/useBranchSwitch';
import { chatsWorkingInCheckout, type MainBranchBlock, mainBranchBlock } from './mainBranch';

import type { ChatWorkspaceChoice, CommandResult, FolderId, ProjectId } from '@clowdy/protocol';
import type { MainBranchControls } from './WorkspaceChips';

/** Makes the chat of the first message: the page hands it over to run it as the switch of the folder's checkout it is. */
export type CreateChat = () => Promise<CommandResult>;

export interface MainBranch {
    /** What the pill needs to pick the branch (`WorkspaceChips`). */
    controls: MainBranchControls;
    /**
     * Wraps the making of the chat when the page chose a branch of the folder's own checkout: the place shows the switch while the daemon runs it (`BranchSwitch.around`: the Changes sidebar's button
     * spins, the moves to and from `origin` are off, and the facts and the folder's branch are read again when it ends), a refusal is kept for the pill, and a switch that was made with something to
     * say (a `post-checkout` hook that failed, commits a detached HEAD left on no branch) is told in a toast, since the page gives way to the chat. Absent for every other choice.
     */
    around: ((create: CreateChat) => Promise<CommandResult>) | undefined;
}

/** What the daemon refused with, as the pill shows it. */
function refusalOf(result: Extract<CommandResult, { ok: false }>): MainBranchBlock {
    const hint = (result.error.details as { hint?: unknown } | undefined)?.hint;

    return { message: result.error.message, ...(typeof hint === 'string' && { hint }) };
}

/**
 * The branch of the folder's own checkout for the new-chat page (the `Main worktree` row of `WorkspaceChips`). The place is the folder's checkout and its git facts are the Changes sidebar's
 * (`PlaceFacts`, `BranchSwitch`: one answer and one switch for the place, wherever they are drawn). **Nothing is read until the list opens**: the branches (`GET git/branches`) and the status of the
 * tree, so the page costs git nothing while the person types. What the window knows is in the way (the tree has changes, chats of the project work in the folder: `mainBranchBlock`) dims
 * every other branch with the daemon's own words; the daemon judges again when the chat is made, and what it answers when it refuses (a tree that changed since, a merge under way) is kept as the
 * `refusal` until the choice changes, so the pill says why the chat did not start and the message stays in the box.
 */
export function useMainBranch(
    projectId: ProjectId,
    folderId: FolderId,
    choice: ChatWorkspaceChoice | undefined
): MainBranch {
    const root = useRootStore();
    const { chats, runs, project } = useProjectState();
    const key: GitPlaceKey = { projectId, folderId };
    const facts = gitFactsOf(root.transport).of(key);
    const model = useBranchSwitch(facts);
    const branch = choice?.mode === 'main' ? choice.branch : undefined;
    const [refused, setRefused] = useState<{ branch: string; folderId: FolderId; why: MainBranchBlock }>();

    // What the daemon refused is about one choice of one folder.
    useEffect(() => setRefused(undefined), [branch, folderId]);

    const working = chatsWorkingInCheckout(chats.values(), runs, project.folders, folderId);
    const block = mainBranchBlock(working, facts.status.value);
    const refusal = refused && refused.branch === branch && refused.folderId === folderId ? refused.why : undefined;

    return {
        controls: {
            listing: model.listing,
            loading: model.loading,
            listFailure: model.listFailure,
            block,
            refusal,
            running: model.running,
            onOpen: () => {
                model.dismiss();
                void model.load();
                void facts.status.refresh();
            },
        },
        around:
            branch === undefined
                ? undefined
                : async create => {
                      const result = await model.around(branch, create);

                      if (!result.ok) {
                          setRefused({ branch, folderId, why: refusalOf(result) });
                      } else {
                          const warning = (result.data as { warning?: unknown } | undefined)?.warning;

                          if (typeof warning === 'string')
                              toast.warning({ title: `Switched to ${branch}`, message: warning, timeout: 12_000 });
                      }

                      return result;
                  },
    };
}

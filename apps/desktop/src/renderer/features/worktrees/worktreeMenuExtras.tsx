import { Trash } from '@clowdy/icons/14';

import { openRemoveWorktree } from './RemoveWorktreeDialog';

import type { OpenMenuExtra } from '../openWith/OpenWithMenu';
import type { WorktreeTarget } from './worktreeActions';

/** Identical actions in the current-place and sidebar card menus, independent of grouping. */
export function worktreeMenuExtras(target: WorktreeTarget): OpenMenuExtra[] {
    return [
        {
            id: 'remove-worktree',
            label: 'Remove worktree…',
            icon: <Trash />,
            isDanger: true,
            run: () => void openRemoveWorktree(target),
        },
    ];
}

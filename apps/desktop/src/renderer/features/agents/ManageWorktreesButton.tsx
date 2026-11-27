import { Button } from '@clowdy/components/Button';
import { Split } from '@clowdy/icons/14';

import { useProjectState, useRootStore } from '../../stores';
import { openManageWorktrees } from '../worktrees';

/** Keep worktree management accessible from the chat list, regardless of its layout. */
export function ManageWorktreesButton() {
    const root = useRootStore();
    const project = useProjectState().project;
    if (!project.folders.length) return null;

    return (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            aria-label="Manage worktrees"
            tooltip="Manage worktrees"
            onPress={() => openManageWorktrees({ root, projectId: project.id })}
        >
            <Split />
        </Button>
    );
}

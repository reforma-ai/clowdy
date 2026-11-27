import { Button } from '@clowdy/components/Button';
import { Mop } from '@clowdy/icons/14';

import { useProjectState, useRootStore } from '../../stores';
import { openManageWorktrees } from '../worktrees';

/** Keep worktree cleanup accessible from the chat list, regardless of its layout. */
export function TidyWorktreesButton() {
    const root = useRootStore();
    const project = useProjectState().project;
    if (!project.folders.length) return null;

    return (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            aria-label="Tidy up worktrees"
            tooltip="Tidy up worktrees"
            onPress={() => openManageWorktrees({ root, projectId: project.id, initialTidy: true })}
        >
            <Mop />
        </Button>
    );
}
